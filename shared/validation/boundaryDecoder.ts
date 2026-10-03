type DecodePath = readonly (string | number)[];
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export class BoundaryDecodeError extends Error {
  readonly path: DecodePath;

  constructor(message: string, path: DecodePath = []) {
    const location = path.length === 0 ? "input" : `input.${path.join(".")}`;
    super(`${location}: ${message}`);
    this.name = "BoundaryDecodeError";
    this.path = path;
  }
}

export interface BoundaryCursor {
  readonly value: unknown;
  readonly path: DecodePath;
  child(key: string | number, value: unknown): BoundaryCursor;
  fail(message: string): never;
}

export interface BoundarySchema<T> {
  decode(cursor: BoundaryCursor): T;
}

type ObjectValue = { [key: string]: unknown };
type ObjectFields = { [key: string]: BoundarySchema<unknown> };
type InferSchema<Schema> = Schema extends BoundarySchema<infer Value> ? Value : never;
type InferObject<Fields extends ObjectFields> = {
  [Key in keyof Fields]: InferSchema<Fields[Key]>;
};

function cursor(value: unknown, path: DecodePath = []): BoundaryCursor {
  return {
    value,
    path,
    child(key, childValue) {
      return cursor(childValue, [...path, key]);
    },
    fail(message) {
      throw new BoundaryDecodeError(message, path);
    },
  };
}

function primitive<T extends string | number | boolean>(
  expected: "string" | "number" | "boolean",
): BoundarySchema<T> {
  return {
    decode(current) {
      if (typeof current.value !== expected) current.fail(`expected ${expected}`);
      // SAFETY: The runtime primitive check above establishes T's primitive kind.
      return current.value as T;
    },
  };
}

function materializeObject<Fields extends ObjectFields>(
  entries: Array<[string, unknown]>,
): InferObject<Fields>;
function materializeObject(entries: Array<[string, unknown]>): ObjectValue {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function decodeUnion<Schemas extends readonly BoundarySchema<unknown>[]>(
  schemas: Schemas,
  current: BoundaryCursor,
): InferSchema<Schemas[number]> {
  const failures: string[] = [];
  for (const schema of schemas) {
    try {
      // SAFETY: Schemas[number] is the schema being decoded in this iteration.
      return schema.decode(current) as InferSchema<Schemas[number]>;
    } catch (error) {
      if (!(error instanceof BoundaryDecodeError)) throw error;
      failures.push(error.message);
    }
  }
  return current.fail(`did not match any allowed shape: ${failures.join("; ")}`);
}

function decodeJsonValue(current: BoundaryCursor): JsonValue {
  if (
    current.value === null ||
    typeof current.value === "string" ||
    typeof current.value === "number" ||
    typeof current.value === "boolean"
  ) {
    return current.value;
  }
  if (Array.isArray(current.value)) {
    return current.value.map((value, index) => decodeJsonValue(current.child(index, value)));
  }
  if (typeof current.value === "object") {
    // SAFETY: The null and array branches above leave only indexable JSON objects.
    const source = current.value as ObjectValue;
    const decoded: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(source)) {
      // Match JSON.stringify: an undefined property is an absent key, not an invalid value.
      if (value === undefined) continue;
      decoded[key] = decodeJsonValue(current.child(key, value));
    }
    return decoded;
  }
  return current.fail("expected JSON value");
}

function decodeJsonObject(current: BoundaryCursor): JsonObject {
  const value = decodeJsonValue(current);
  if (value !== null && !Array.isArray(value) && typeof value === "object") return value;
  return current.fail("expected JSON object");
}

export const boundary = {
  string: primitive<string>("string"),
  nonEmptyString: {
    decode(current: BoundaryCursor): string {
      const value = primitive<string>("string").decode(current);
      return value.trim().length > 0 ? value : current.fail("expected non-empty string");
    },
  } satisfies BoundarySchema<string>,
  number: primitive<number>("number"),
  boolean: primitive<boolean>("boolean"),
  json: { decode: decodeJsonValue } satisfies BoundarySchema<JsonValue>,
  jsonObject: { decode: decodeJsonObject } satisfies BoundarySchema<JsonObject>,
  literal<const Value extends string | number | boolean | null>(
    expected: Value,
  ): BoundarySchema<Value> {
    return {
      decode(current) {
        if (current.value !== expected) current.fail(`expected literal ${String(expected)}`);
        return expected;
      },
    };
  },
  enumeration<const Values extends readonly (string | number)[]>(
    ...values: Values
  ): BoundarySchema<Values[number]> {
    return {
      decode(current) {
        for (const value of values) {
          if (current.value === value) return value;
        }
        return current.fail(`expected one of ${values.join(", ")}`);
      },
    };
  },
  optional<Value>(schema: BoundarySchema<Value>): BoundarySchema<Value | undefined> {
    return {
      decode(current) {
        return current.value === undefined ? undefined : schema.decode(current);
      },
    };
  },
  nullable<Value>(schema: BoundarySchema<Value>): BoundarySchema<Value | null> {
    return {
      decode(current) {
        return current.value === null ? null : schema.decode(current);
      },
    };
  },
  array<Value>(schema: BoundarySchema<Value>): BoundarySchema<Value[]> {
    return {
      decode(current) {
        const values = current.value;
        if (Array.isArray(values)) {
          return values.map((value, index) => schema.decode(current.child(index, value)));
        }
        return current.fail("expected array");
      },
    };
  },
  object<const Fields extends ObjectFields>(fields: Fields): BoundarySchema<InferObject<Fields>> {
    return {
      decode(current) {
        if (typeof current.value !== "object" || current.value === null || Array.isArray(current.value)) {
          current.fail("expected object");
        }
        // SAFETY: The object/null/array checks above establish an indexable plain object.
        const source = current.value as ObjectValue;
        const decoded: Array<[string, unknown]> = [];
        for (const key of Object.keys(fields)) {
          const schema = fields[key];
          if (schema === undefined) current.fail(`missing schema for ${key}`);
          decoded.push([key, schema.decode(current.child(key, source[key]))]);
        }
        return materializeObject<Fields>(decoded);
      },
    };
  },
  union<const Schemas extends readonly BoundarySchema<unknown>[]>(
    ...schemas: Schemas
  ): BoundarySchema<InferSchema<Schemas[number]>> {
    return {
      decode(current) {
        return decodeUnion(schemas, current);
      },
    };
  },
};

export function decodeBoundary<Value>(
  value: unknown,
  schema: BoundarySchema<Value>,
): Value {
  return schema.decode(cursor(value));
}

export function decodeOptionalBoundary<Value>(
  value: unknown,
  schema: BoundarySchema<Value>,
): Value | undefined {
  try {
    return decodeBoundary(value, schema);
  } catch (error) {
    if (error instanceof BoundaryDecodeError) return undefined;
    throw error;
  }
}
