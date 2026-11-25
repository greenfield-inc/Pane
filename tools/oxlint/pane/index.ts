import { eslintCompatPlugin } from "@oxlint/plugins";

import { noBareTodoNumberRule } from "./rules/no-bare-todo-number.ts";

/** Pane's own Oxlint rules, for invariants specific to this codebase (docs/lint/oxlint.md). */
const panePlugin = eslintCompatPlugin({
  meta: { name: "pane" },
  rules: {
    "no-bare-todo-number": noBareTodoNumberRule,
  },
});

export default panePlugin;
