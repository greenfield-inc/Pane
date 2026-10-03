import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundary as sharedBoundary,
  BoundaryDecodeError as SharedDecodeError,
  decodeBoundary as decodeShared,
  decodeOptionalBoundary as decodeOptionalShared,
} from "../shared/validation/boundaryDecoder.ts";
import {
  boundary as runpaneBoundary,
  BoundaryDecodeError as RunpaneDecodeError,
  decodeBoundary as decodeRunpane,
  decodeOptionalBoundary as decodeOptionalRunpane,
} from "../packages/runpane/src/boundaryDecoder.ts";

for (const [name, boundary, decodeBoundary, decodeOptionalBoundary, DecodeError] of [
  ["shared", sharedBoundary, decodeShared, decodeOptionalShared, SharedDecodeError],
  ["RunPane", runpaneBoundary, decodeRunpane, decodeOptionalRunpane, RunpaneDecodeError],
]) {

  test(`${name}: union failures explain each alternative at its field path`, () => {
    const schema = boundary.object({
      payload: boundary.union(
        boundary.object({ count: boundary.number }),
        boundary.object({ names: boundary.array(boundary.string) }),
      ),
    });
    assert.throws(() => decodeBoundary({ payload: { count: "two", names: [7] } }, schema), {
      name: "BoundaryDecodeError",
      message: "input.payload: did not match any allowed shape: input.payload.count: expected number; input.payload.names.0: expected string",
      path: ["payload"],
    });
    assert.deepEqual(decodeBoundary({ payload: { names: ["Ada"] } }, schema), {
      payload: { names: ["Ada"] },
    });
  });

  test(`${name}: JSON objects omit undefined keys while retaining explicit null`, () => {
    assert.deepEqual(decodeBoundary({ omitted: undefined, nested: { absent: undefined, kept: null } }, boundary.jsonObject), {
      nested: { kept: null },
    });
    assert.throws(() => decodeBoundary([undefined], boundary.json), error => {
      assert.ok(error instanceof DecodeError);
      assert.equal(error.message, "input.0: expected JSON value");
      return true;
    });
  });

  test(`${name}: optional decoding suppresses invalid input but preserves programmer errors`, () => {
    assert.equal(decodeOptionalBoundary(3, boundary.string), undefined);
    assert.equal(decodeOptionalBoundary("valid", boundary.string), "valid");
    const failure = new Error("schema implementation failed");
    const brokenSchema = { decode() { throw failure; } };
    assert.throws(() => decodeOptionalBoundary(null, brokenSchema), error => error === failure);
    assert.throws(() => decodeBoundary(null, boundary.union(brokenSchema, boundary.string)), error => error === failure);
  });
}
