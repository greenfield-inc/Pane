// Seeded lint violations: one or more per ESLint rule. Throwaway; never merged.
/// <reference path="./nothing.d.ts" />
import fs = require('fs');
declare const input: string;
declare const maybe: { value?: { run(): void } } | undefined;
declare function sideEffect(): number;

export function seeded(list: number[], flag: boolean, n: number): unknown {
  for (let i = 0; i < 10; i--) sideEffect(); // for-direction
  const p = new Promise(async (resolve) => { resolve(1); }); // no-async-promise-executor
  switch (n) {
    case 1:
      const scoped = 1; // no-case-declarations
      sideEffect();
    // falls through on purpose below (no-fallthrough)
    case 2:
      sideEffect();
    case 3:
      break;
    case 3: // no-duplicate-case
      break;
  }
  if (n === -0) sideEffect(); // no-compare-neg-zero
  let assigned;
  if (assigned = n) sideEffect(); // no-cond-assign
  const always = (n + 1) ?? 2; // no-constant-binary-expression
  if (true) sideEffect(); // no-constant-condition
  const control = /\x1f/; // no-control-regex
  debugger; // no-debugger
  if (n === 1) sideEffect(); else if (n === 1) sideEffect(); // no-dupe-else-if
  const emptyClass = /^abc[]/; // no-empty-character-class
  const {} = list; // no-empty-pattern
  class Holder { static {} } // no-empty-static-block
  try { sideEffect(); } catch (error) { error = 1; } // no-ex-assign
  if (!!flag) sideEffect(); // no-extra-boolean-cast
  const bad = RegExp('['); // no-invalid-regexp
  const spaced= 1; // no-irregular-whitespace (U+000B before =)
  const lossy = 9007199254740993; // no-loss-of-precision
  const misleading = /^[👍]$/; // no-misleading-character-class
  const owns = list.hasOwnProperty('x'); // no-prototype-builtins
  const spaces = /a   b/; // no-regex-spaces
  n = n; // no-self-assign
  const sparse = [1, , 2]; // no-sparse-arrays
  const multiline = sideEffect
  (n) // no-unexpected-multiline
  try { return 1; } finally { return 2; } // no-unsafe-finally
}

export function more(n: number, list: number[]): unknown {
  const unsafe = (maybe?.value).run(); // no-unsafe-optional-chaining
  label: for (const x of [n]) sideEffect(); // no-unused-labels
  class Secret { #unused = 1; } // no-unused-private-class-members
  const backref = /(a)|\1b/; // no-useless-backreference
  try { sideEffect(); } catch (error) { throw error; } // no-useless-catch
  const escaped = '\a'; // no-useless-escape
  var legacy = 1; // no-var
  let neverReassigned = 2; // prefer-const
  function rest() { return arguments; } // prefer-rest-params
  Math.max.apply(Math, list); // prefer-spread
  function* noYield() { return 1; } // require-yield
  if (n === NaN) sideEffect(); // use-isnan
  if (typeof n === 'strnig') sideEffect(); // valid-typeof
  try { sideEffect(); } catch {} // no-empty
  function shadow(undefined: number) { return undefined; } // no-shadow-restricted-names
  Object = null; // no-global-assign
  return [unsafe, backref, escaped, legacy, neverReassigned, rest, noYield, shadow, Secret];
}

// @ts-ignore ban-ts-comment
export const arr = new Array(1, 2); // no-array-constructor
export enum Dup { A = 1, B = 1 } // no-duplicate-enum-values
export interface Empty {} // no-empty-object-type
export const anything: any = 1; // no-explicit-any
export const extra = maybe!!.value; // no-extra-non-null-assertion
export interface Ctor { new (): Ctor } // no-misused-new
export namespace Space { export const x = 1; } // no-namespace
export const asserted = maybe?.value!; // no-non-null-asserted-optional-chain
export class Aliased { run() { const self = this; return self; } } // no-this-alias
export function constrained<T extends any>(value: T) { return value; } // no-unnecessary-type-constraint
export interface Merged { x: number } export class Merged {} // no-unsafe-declaration-merging
export const fn: Function = () => 1; // no-unsafe-function-type
export const unusedExpression = () => { input; }; // no-unused-expressions
const unusedVariable = 1; // no-unused-vars
export const wrapper: String = 'x'; // no-wrapper-object-types
export const asConst = { kind: 'a' as 'a' }; // prefer-as-const
export module Legacy { export const y = 1; } // prefer-namespace-keyword
export const required = require('path'); // no-require-imports
export const fsModule = fs;
