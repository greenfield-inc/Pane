import { describe, expect, it } from 'vitest';
import {
  boundary,
  BoundaryDecodeError,
  BoundaryDecodeIssues,
  decodeBoundary,
  decodeBoundaryAll,
  decodeOptionalBoundary,
  type BoundaryCursor,
  type BoundarySchema,
  type DecodePath,
} from '../../../shared/validation/boundaryDecoder';

const itemSchema = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.refine(boundary.nonEmptyString, value => value.startsWith('https://'), 'expected an https URL'),
  note: boundary.optional(boundary.string),
});
const payloadSchema = boundary.object({
  name: boundary.optional(boundary.string),
  items: boundary.optional(boundary.array(itemSchema)),
  tags: boundary.optional(boundary.array(boundary.string)),
  choice: boundary.optional(boundary.union(boundary.literal('a'), itemSchema)),
});

function issuesOf(run: () => void): BoundaryDecodeIssues {
  try {
    run();
  } catch (error) {
    if (error instanceof BoundaryDecodeIssues) return error;
    throw error;
  }
  throw new Error('expected decoding to fail');
}

describe('decodeBoundaryAll', () => {
  it('collects missing own fields rather than accepting inherited values', () => {
    const inherited = Object.setPrototypeOf({}, { label: 'inherited', url: 'https://example.test' });

    const error = issuesOf(() => decodeBoundaryAll({ items: [inherited] }, payloadSchema));

    expect(error.issues.map(issue => `${issue.where}: ${issue.message}`)).toEqual([
      'items[0].label: missing',
      'items[0].url: missing',
    ]);
    expect(() => decodeBoundary(inherited, itemSchema)).toThrow('input.label: expected string');
  });

  it('reports every field problem at once, with "missing" for absent required fields', () => {
    const error = issuesOf(() => decodeBoundaryAll({
      name: 3,
      items: [{}, { label: 'ok', url: 'ftp://x' }],
      tags: ['fine', 1],
    }, payloadSchema));

    expect(error.issues.map(issue => `${issue.where}: ${issue.message}`)).toEqual([
      'name: expected string',
      'items[0].label: missing',
      'items[0].url: missing',
      'items[1].url: expected an https URL',
      'tags[1]: expected string',
    ]);
    expect(error.message).toBe(
      'name: expected string; items[0].label: missing; items[0].url: missing; '
      + 'items[1].url: expected an https URL; tags[1]: expected string',
    );
    expect(error).toBeInstanceOf(BoundaryDecodeError);
  });

  it('returns the same value as decodeBoundary for valid input', () => {
    const value = { name: 'n', items: [{ label: 'l', url: 'https://x', note: 'n' }], tags: ['t'], choice: 'a' };
    expect(decodeBoundaryAll(value, payloadSchema)).toEqual(decodeBoundary(value, payloadSchema));
  });

  it('reports a union that matches no shape once, at the union path', () => {
    const error = issuesOf(() => decodeBoundaryAll({ choice: { label: 'x' } }, payloadSchema));
    expect(error.issues.map(issue => `${issue.where}: ${issue.message}`)).toEqual(['choice: did not match any allowed shape']);
  });

  it('reports a non-object root as one issue at "input"', () => {
    const error = issuesOf(() => decodeBoundaryAll([], payloadSchema));
    expect(error.issues.map(issue => `${issue.where}: ${issue.message}`)).toEqual(['input: expected object']);
  });

  it('leaves decodeBoundary stopping at the first error with its existing text', () => {
    expect(() => decodeBoundary({ items: [{}] }, payloadSchema)).toThrow('input.items.0.label: expected string');
  });

  it('F-2: keeps JSON keys named __proto__ as own data, at the top level and nested', () => {
    const text = '{"__proto__":{"state":"changed","__proto__":{"deep":true}},"ok":true}';
    const decoded = decodeBoundary(JSON.parse(text), boundary.jsonObject);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(JSON.stringify(decoded)).toBe(text);
    expect(JSON.stringify(decodeBoundary(JSON.parse(`[${text}]`), boundary.json))).toBe(`[${text}]`);
  });

  it('F-1: rejects JSON nested past the depth limit with a decode error, not a stack overflow', () => {
    const deep = JSON.parse(`{"x":${'['.repeat(20_000)}0${']'.repeat(20_000)}}`);
    expect(() => decodeBoundary(deep, boundary.jsonObject)).toThrow(BoundaryDecodeError);
    const fine = JSON.parse(`{"x":${'['.repeat(100)}0${']'.repeat(100)}}`);
    expect(JSON.stringify(decodeBoundary(fine, boundary.jsonObject))).toBe(JSON.stringify(fine));
  });
});

function decodeErrorOf(run: () => void): BoundaryDecodeError {
  try {
    run();
  } catch (error) {
    if (error instanceof BoundaryDecodeError) return error;
    throw error;
  }
  throw new Error('expected decoding to fail');
}

// #1624: cursors build their path only when it is read, and union and optional misses throw a shared
// error instead of building one. Neither may change what decoding returns or reports.
describe('decoding results and errors', () => {
  const figureSchema = boundary.union(
    boundary.object({ kind: boundary.literal('circle'), radius: boundary.number }),
    boundary.object({ kind: boundary.literal('box'), sides: boundary.array(boundary.union(boundary.number, boundary.literal('auto'))) }),
  );
  const drawingSchema = boundary.object({
    name: boundary.nonEmptyString,
    figures: boundary.array(figureSchema),
    meta: boundary.optional(boundary.record(boundary.json)),
  });

  it('decodes valid input, including nested unions and JSON, to the same value', () => {
    const value = {
      name: 'd',
      figures: [{ kind: 'circle', radius: 2, extra: true }, { kind: 'box', sides: [1, 'auto', 3] }],
      meta: { tags: ['a', { deep: [null, 1, { x: 'y' }] }] },
    };
    expect(decodeBoundary(value, drawingSchema)).toEqual({
      name: 'd',
      figures: [{ kind: 'circle', radius: 2 }, { kind: 'box', sides: [1, 'auto', 3] }],
      meta: value.meta,
    });
    expect(decodeOptionalBoundary(value, drawingSchema)).toEqual(decodeBoundary(value, drawingSchema));
  });

  it('reports the first failure with its full path and message', () => {
    const cases: Array<[unknown, string, DecodePath]> = [
      [[], 'input: expected object', []],
      [{ name: ' ', figures: [] }, 'input.name: expected non-empty string', ['name']],
      [{ name: 'd', figures: [{ kind: 'circle', radius: 1 }, { kind: 'box', sides: [1, 'x'] }] }, 'input.figures.1: did not match any allowed shape', ['figures', 1]],
      [{ name: 'd', figures: [], meta: { a: { b: [1, () => 0] } } }, 'input.meta.a.b.1: expected JSON value', ['meta', 'a', 'b', 1]],
    ];
    for (const [value, message, path] of cases) {
      const error = decodeErrorOf(() => decodeBoundary(value, drawingSchema));
      expect(error.message).toBe(message);
      expect(error.path).toEqual(path);
      expect(decodeOptionalBoundary(value, drawingSchema)).toBeUndefined();
    }
  });

  it('collects the same issues from decodeBoundaryAll, with a union miss once at the union path', () => {
    const error = issuesOf(() => decodeBoundaryAll({ figures: [{ kind: 'box', sides: ['x'] }, 3], meta: { k: () => 0 } }, drawingSchema));
    expect(error.issues.map(issue => [issue.where, issue.message, issue.path])).toEqual([
      ['name', 'missing', ['name']],
      ['figures[0]', 'did not match any allowed shape', ['figures', 0]],
      ['figures[1]', 'did not match any allowed shape', ['figures', 1]],
      ['meta.k', 'expected JSON value', ['meta', 'k']],
    ]);
  });

  it('gives a union branch that catches decode errors a BoundaryDecodeError, as before', () => {
    const caught: unknown[] = [];
    const fallback: BoundarySchema<string> = {
      decode(current) {
        try {
          return boundary.string.decode(current);
        } catch (error) {
          caught.push(error);
          if (error instanceof BoundaryDecodeError) return 'fallback';
          throw error;
        }
      },
    };
    expect(decodeBoundary({ value: 4 }, boundary.object({ value: boundary.union(boundary.boolean, fallback) }))).toEqual({ value: 'fallback' });
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(BoundaryDecodeError);
  });

  it('lets errors that are not decode errors escape unions and decodeOptionalBoundary', () => {
    const broken: BoundarySchema<never> = { decode() { throw new RangeError('schema bug'); } };
    expect(() => decodeBoundary(1, boundary.union(boundary.string, broken))).toThrow(RangeError);
    expect(() => decodeOptionalBoundary(1, broken)).toThrow(RangeError);
  });

  it('gives each cursor a depth equal to its path length, and paths that survive strict()', () => {
    const seen: Array<[number, DecodePath]> = [];
    const probe: BoundarySchema<null> = {
      decode(current: BoundaryCursor) {
        seen.push([current.depth, current.path], [current.strict().depth, current.strict().path]);
        return null;
      },
    };
    decodeBoundary({ a: [{ b: 1 }] }, boundary.object({ a: boundary.array(boundary.object({ b: probe })) }));
    expect(seen).toEqual([[3, ['a', 0, 'b']], [3, ['a', 0, 'b']]]);
  });
});
