import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

if (readFileSync(primitives[0], "utf8") !== readFileSync(primitives[1], "utf8")) {
  throw new Error("Boundary decoder copies differ. Copy shared/validation/boundaryDecoder.ts to packages/runpane/src/boundaryDecoder.ts after editing the shared source.");
}

execFileSync(process.execPath, ["--test", join(root, "scripts", "test-boundary-decoder.mjs")], {
  cwd: root,
  stdio: "inherit",
});

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
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("Boundary decoder lint conformance checks passed");
