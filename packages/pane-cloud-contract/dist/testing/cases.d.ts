import { type CloudErrorCode } from '../errors';
/** One contract check. Run each with your own test framework: `for (const c of cases) test(c.name, c.run)`. */
export interface ContractCase {
    name: string;
    run(): Promise<void>;
}
export declare function expectError(code: CloudErrorCode, call: () => Promise<object>): Promise<void>;
/** Polls `read` until `done` holds, so the same case passes on an instant stub and a real fleet. */
export declare function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs: number): Promise<T>;
