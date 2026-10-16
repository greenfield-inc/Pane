import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve oxlint's real Node entry (its bin is a plain ESM shim) and invoke it
// with the current Node executable. This avoids the platform-specific .bin
// shims (Node 24 refuses to spawn the Windows oxlint.cmd without a shell,
// throwing EINVAL) and needs no shell, so it is safe on all platforms.
const oxlintManifestPath = require.resolve("oxlint/package.json");
const oxlintArgs = [join(dirname(oxlintManifestPath), require(oxlintManifestPath).bin.oxlint)];
const config = join(root, ".oxlintrc.json");
const primitives = [
  join(root, "shared", "validation", "boundaryDecoder.ts"),
  join(root, "packages", "runpane", "src", "boundaryDecoder.ts"),
];

execFileSync(process.execPath, [...oxlintArgs, "--config", config, "--deny-warnings", ...primitives], {
  cwd: root,
  stdio: "pipe",
});

const fixtureDirectory = mkdtempSync(join(root, "shared", "validation", ".boundary-conformance-"));
const fixture = join(fixtureDirectory, "downstream.ts");

try {
  writeFileSync(
    fixture,
    [
      "type UnsafeValues = { [key: string]: unknown };",
      "export function leak(value: unknown): UnsafeValues {",
      "  return typeof value === 'object' && value !== null ? {} : {};",
      "}",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [...oxlintArgs, "--config", config, "--deny-warnings", fixture], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  const expectedRules = [
    "no-runtime-typeof",
    "no-unknown-parameters",
    "no-unsafe-dictionary-type",
  ];
  if (result.status === 0 || expectedRules.some((rule) => !output.includes(rule))) {
    throw new Error(`Boundary decoder conformance probe did not report all expected rules:\n${output}`);
  }
  // Generic parsers must not hide an unparsed input behind an unconstrained type parameter.
  // Real generic contracts retain their input type in the result or constrain it.
  writeFileSync(fixture, [
    "export function parse<Value>(value: Value): string { return String(value); }",
    "export const parseArrow = <Value>(value: Value): number => Number(value);",
    "export type Parser = <Value>(value: Value) => boolean;",
    "export function identity<Value>(value: Value): Value { return value; }",
    "export function constrained<Value extends { id: string }>(value: Value): string { return value.id; }",
    "export function inferred<Value>(value: Value) { return value; }",
    "export function apply<Value>(value: Value, fn: (input: Value) => string): string { return fn(value); }",
    "export function same<T, U extends T>(left: T, right: U): boolean { return left === right; }",
    "type Box<Value> = { value: Value };",
    "export function boxed<Value>(value: Value): Box<Value> { return { value }; }",
  ].join("\n"));
  const genericResult = spawnSync(process.execPath, [...oxlintArgs, "--config", config, "--format", "json", fixture], {
    cwd: root,
    encoding: "utf8",
  });
  const genericDiagnostics = JSON.parse(genericResult.stdout).diagnostics.filter(
    (diagnostic) => diagnostic.code === "anti-slop(no-unknown-parameters)",
  );
  const reportedLines = genericDiagnostics.map((diagnostic) => diagnostic.labels[0].span.line).sort();
  if (JSON.stringify(reportedLines) !== "[1,2,3]") {
    throw new Error(`Generic parser contract probe expected lines 1,2,3, got ${JSON.stringify(reportedLines)}:\n${genericResult.stdout}`);
  }
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("Boundary decoder lint conformance checks passed");
