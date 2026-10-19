import { describe, expect, it } from 'vitest';
import {
  boundary,
  BoundaryDecodeError,
  BoundaryDecodeIssues,
  decodeBoundary,
  decodeBoundaryAll,
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
});
