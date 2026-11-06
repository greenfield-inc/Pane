"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expectError = expectError;
exports.waitFor = waitFor;
const strict_1 = __importDefault(require("node:assert/strict"));
const errors_1 = require("../errors");
async function expectError(code, call) {
    try {
        await call();
    }
    catch (error) {
        strict_1.default.ok(error instanceof errors_1.CloudApiError, `expected CloudApiError ${code}, got ${String(error)}`);
        strict_1.default.equal(error.code, code);
        return;
    }
    strict_1.default.fail(`expected the call to fail with ${code}, and it succeeded`);
}
/** Polls `read` until `done` holds, so the same case passes on an instant stub and a real fleet. */
async function waitFor(read, done, what, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (done(value))
            return value;
        if (Date.now() > deadline)
            strict_1.default.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(20, timeoutMs / 100))));
    }
}
