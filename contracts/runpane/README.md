# Runpane Contract

`contract.json` is the source of truth for public `runpane` command metadata,
help text, docs fragments, parity fixtures, and the JSON schemas for `--json`
results (under `jsonSchemas`). `schema.json` validates `contract.json` itself.

Update flow:

```bash
node scripts/generate-runpane-contract.js
node scripts/generate-runpane-contract.js --check
pnpm run test:runpane-contract
```

Keep this contract product-level. Public terms should be `repos`, `panes`,
`tools`, and `agents`; internal IPC channel names such as `sessions:create` or
`panels:create` should not appear in the stable public contract.
