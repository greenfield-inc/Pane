export type DecodePath = readonly (string | number)[];
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export class BoundaryDecodeError extends Error {
  readonly path: DecodePath;
  /** The problem without its location, such as "expected string". */
  readonly reason: string;

  constructor(message: string, path: DecodePath = []) {
    const location = path.length === 0 ? "input" : `input.${path.join(".")}`;
    super(`${location}: ${message}`);
    this.name = "BoundaryDecodeError";
    this.path = path;
    this.reason = message;
  }
}

/** One problem found by `decodeBoundaryAll`; `where` reads like `outputs[0].label` ("input" for the root). */
export interface BoundaryIssue {
  readonly path: DecodePath;
  readonly where: string;
  readonly message: string;
}

/** Every problem `decodeBoundaryAll` found, in schema field order; the message lists them as `where: message; ...`. */
export class BoundaryDecodeIssues extends BoundaryDecodeError {
  readonly issues: readonly BoundaryIssue[];

  constructor(issues: readonly BoundaryIssue[]) {
    const text = issues.map(issue => `${issue.where}: ${issue.message}`).join("; ");
    super(text, []);
    this.name = "BoundaryDecodeIssues";
    this.message = text;
    this.issues = issues;
  }
}

/** `outputs[0].label` notation for a decode path; the root is "input". */
export function formatBoundaryPath(path: DecodePath): string {
  if (path.length === 0) return "input";
  return path.reduce<string>((text, key) => {
    if (typeof key === "number") return `${text}[${key}]`;
    return text.length === 0 ? key : `${text}.${key}`;
  }, "");
}

export interface BoundaryCursor {
  readonly value: unknown;
  readonly path: DecodePath;
  child(key: string | number, value: unknown): BoundaryCursor;
  fail(message: string): never;
  /**
   * Records a child's failure when decoding with `decodeBoundaryAll` and returns true, so the
   * caller moves on to the next field; returns false otherwise, and the caller rethrows.
   */
  collect(error: BoundaryDecodeError): boolean;
  /** The same position without collecting, for schemas that must see the first failure (unions). */
  strict(): BoundaryCursor;
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

function cursor(value: unknown, path: DecodePath = [], issues?: BoundaryIssue[]): BoundaryCursor {
  return {
    value,
    path,
    child(key, childValue) {
      return cursor(childValue, [...path, key], issues);
    },
    fail(message) {
      throw new BoundaryDecodeError(message, path);
    },
    collect(error) {
      if (!issues) return false;
      issues.push(issueFrom(error));
      return true;
    },
    strict() {
      return cursor(value, path);
    },
  };
}

function issueFrom(error: BoundaryDecodeError): BoundaryIssue {
  return { path: error.path, where: formatBoundaryPath(error.path), message: error.reason };
}

/** Decodes one child; in collecting mode a failure is recorded (an absent value as "missing") and undefined returned. */
function decodeChild<Value>(
  current: BoundaryCursor,
  key: string | number,
  value: unknown,
  schema: BoundarySchema<Value>,
): Value | undefined {
  const child = current.child(key, value);
  try {
    return schema.decode(child);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    const reported = value === undefined ? new BoundaryDecodeError("missing", child.path) : error;
    if (!current.collect(reported)) throw error;
    return undefined;
  }
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
  for (const schema of schemas) {
    try {
      // SAFETY: Schemas[number] is the schema being decoded in this iteration.
      return schema.decode(current.strict()) as InferSchema<Schemas[number]>;
    } catch (error) {
      if (!(error instanceof BoundaryDecodeError)) throw error;
    }
  }
  return current.fail("did not match any allowed shape");
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
    const decoded: Array<[string, JsonValue]> = [];
    for (const [key, value] of Object.entries(source)) {
      // Match JSON.stringify: an undefined property is an absent key, not an invalid value.
      if (value === undefined) continue;
      decoded.push([key, decodeJsonValue(current.child(key, value))]);
    }
    return Object.fromEntries(decoded);
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
          // SAFETY: decodeChild returns undefined only after recording an issue, and decodeBoundaryAll then throws.
          return values.map((value, index) => decodeChild(current, index, value, schema) as Value);
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
          decoded.push([key, decodeChild(current, key, Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined, schema)]);
        }
        return materializeObject<Fields>(decoded);
      },
    };
  },
  /** Accepts a decoded value only when `test` holds; otherwise fails with `message`. */
  refine<Value>(
    schema: BoundarySchema<Value>,
    test: (value: Value) => boolean,
    message: string,
  ): BoundarySchema<Value> {
    return {
      decode(current) {
        const value = schema.decode(current);
        return test(value) ? value : current.fail(message);
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

/**
 * Like `decodeBoundary`, but reports every problem at once: object fields and array items are all
 * decoded, an absent required field reads "missing", and a failure throws `BoundaryDecodeIssues`.
 * Opt-in, for payloads people and agents write by hand.
 */
export function decodeBoundaryAll<Value>(
  value: unknown,
  schema: BoundarySchema<Value>,
): Value {
  const issues: BoundaryIssue[] = [];
  let decoded: Value;
  try {
    decoded = schema.decode(cursor(value, [], issues));
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    issues.push(issueFrom(error));
    throw new BoundaryDecodeIssues(issues);
  }
  if (issues.length > 0) throw new BoundaryDecodeIssues(issues);
  return decoded;
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
