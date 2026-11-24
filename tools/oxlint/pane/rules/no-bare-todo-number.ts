import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Every machine numbers its own to-dos T-1, T-2 and so on, so two machines each have a T-28 (T-51).
 * A to-do number read off a card or a row (`item.todo.number`, `entry.todoNumber`, `row.todo_id`)
 * says nothing once two machines' cards or rows meet. Comparing one, or keying a Map, Set or record
 * by one, is how another machine's card docked in a local Session. Compare and key by a `TodoKey`
 * from `shared/todoKey.ts`, the one file allowed to read the number for that.
 *
 * Showing the number (`T-${item.todo.number}`, `todoRef(n)`) and passing it on are fine.
 */

const HELPER_FILE = /(?:^|[/\\])shared[/\\]todoKey\.ts$/u;
const COMPARISONS = new Set(["===", "!==", "==", "!="]);
// Calls whose first argument is a key or a value looked up by equality.
const KEYED_CALLS = new Set(["has", "get", "set", "delete", "add", "includes", "indexOf", "lastIndexOf"]);
const KEYED_COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
// Fields that hold a to-do number on their own, without its machine.
const NUMBER_FIELDS = new Set(["todoNumber", "todo_id"]);

type Node = ESTree.Node;

function propertyName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return undefined;
}

function unwrap(node: Node): Node {
  let current = node;
  while (current.type === "ChainExpression" || current.type === "TSNonNullExpression" || current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

/** `<x>.todo.number`, `<x>.todo?.number`, `<x>.todoNumber` or `<x>.todo_id`. */
function isBareTodoNumber(node: Node | null | undefined): boolean {
  if (!node) return false;
  const expression = unwrap(node);
  if (expression.type !== "MemberExpression") return false;
  const name = propertyName(expression);
  if (name && NUMBER_FIELDS.has(name)) return true;
  if (name !== "number") return false;
  const owner = unwrap(expression.object);
  return owner.type === "MemberExpression" && propertyName(owner) === "todo";
}

/** A callback that returns a bare to-do number: `row => row.todo.number`, `({ todo }) => ...` is not one. */
function returnsBareTodoNumber(node: Node | undefined): boolean {
  if (!node || (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression")) return false;
  if (node.body.type !== "BlockStatement") return isBareTodoNumber(node.body);
  return node.body.body.some(statement => statement.type === "ReturnStatement" && isBareTodoNumber(statement.argument));
}

/** `xs.map(x => x.todo.number)`, the usual way a Set or Map of numbers is built. */
function mapsToBareTodoNumbers(node: Node | undefined): boolean {
  if (!node) return false;
  const expression = unwrap(node);
  if (expression.type !== "CallExpression") return false;
  const callee = unwrap(expression.callee);
  if (callee.type !== "MemberExpression" || propertyName(callee) !== "map") return false;
  return returnsBareTodoNumber(expression.arguments[0]);
}

/** `[[x.todo.number, value], ...]` or `xs.map(x => [x.todo.number, value])`, a Map's entries keyed by number. */
function entriesKeyedByBareTodoNumber(node: Node | undefined): boolean {
  if (!node) return false;
  const expression = unwrap(node);
  const keyedEntry = (entry: Node | null | undefined): boolean => {
    if (!entry) return false;
    const pair = unwrap(entry);
    return pair.type === "ArrayExpression" && isBareTodoNumber(pair.elements[0]);
  };
  if (expression.type === "ArrayExpression") return expression.elements.some(keyedEntry);
  if (expression.type !== "CallExpression") return false;
  const callee = unwrap(expression.callee);
  if (callee.type !== "MemberExpression" || propertyName(callee) !== "map") return false;
  const callback = expression.arguments[0];
  if (!callback || (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")) return false;
  if (callback.body.type !== "BlockStatement") return keyedEntry(callback.body);
  return callback.body.body.some(statement => statement.type === "ReturnStatement" && keyedEntry(statement.argument));
}

/** `null` or `undefined`: comparing with one asks whether a number is there, not which to-do it is. */
function isAbsence(node: Node): boolean {
  const expression = unwrap(node);
  return (expression.type === "Literal" && expression.value === null) || (expression.type === "Identifier" && expression.name === "undefined");
}

export const noBareTodoNumberRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comparing a bare to-do number, or keying a Map, Set or record by one, outside shared/todoKey.ts.",
    },
    messages: {
      compared:
        "Two machines can each have this T-n. Compare `TodoKey`s (`todoKeyOfItem`, `todoKeyOfRow`, `todoKey` from shared/todoKey.ts), not a bare to-do number.",
      keyed:
        "Two machines can each have this T-n. Key by a `TodoKey` (`todoKeyOfItem`, `todoKeyOfRow`, `todoKey` from shared/todoKey.ts), not a bare to-do number.",
    },
  },
  createOnce(context) {
    let skip = false;
    return {
      before() {
        skip = HELPER_FILE.test(context.filename);
      },
      BinaryExpression(node) {
        if (skip || !COMPARISONS.has(node.operator)) return;
        if (isAbsence(node.left) || isAbsence(node.right)) return;
        if (isBareTodoNumber(node.left) || isBareTodoNumber(node.right)) {
          context.report({ node, messageId: "compared" });
        }
      },
      CallExpression(node) {
        if (skip) return;
        const callee = unwrap(node.callee);
        if (callee.type !== "MemberExpression") return;
        const name = propertyName(callee);
        if (name && KEYED_CALLS.has(name) && isBareTodoNumber(node.arguments[0])) {
          context.report({ node, messageId: name === "includes" || name.endsWith("ndexOf") ? "compared" : "keyed" });
        }
      },
      NewExpression(node) {
        if (skip || node.callee.type !== "Identifier" || !KEYED_COLLECTIONS.has(node.callee.name)) return;
        const source = node.arguments[0];
        const isMap = node.callee.name.endsWith("Map");
        if (isMap ? entriesKeyedByBareTodoNumber(source) : mapsToBareTodoNumbers(source) || (source?.type === "ArrayExpression" && source.elements.some(isBareTodoNumber))) {
          context.report({ node, messageId: "keyed" });
        }
      },
      MemberExpression(node) {
        if (skip || !node.computed) return;
        if (isBareTodoNumber(node.property)) context.report({ node, messageId: "keyed" });
      },
      Property(node) {
        if (skip || !node.computed) return;
        if (isBareTodoNumber(node.key)) context.report({ node, messageId: "keyed" });
      },
    };
  },
});
