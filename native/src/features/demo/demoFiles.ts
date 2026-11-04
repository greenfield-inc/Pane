// Invented sample worktree for the demo's Explorer and file tabs: the shop's checkout code.

const SUBMIT_ORDER = `// One checkout per cart: the second request waits for the lock, then sees "paid".
import { withCartLock } from './cartLock';
import { charge } from '../payments';

export async function submitOrder(cartId: string) {
  return withCartLock(cartId, async () => {
    const cart = await db.carts.get(cartId);
    if (cart.status === 'paid') {
      return { ok: true, duplicate: true };
    }
    const total = priceCart(cart);
    await charge(cart.customerId, total);
    await db.carts.update(cartId, {
      status: 'paid',
      paidAt: new Date(),
    });
    return { ok: true, total };
  });
}

// Retries reuse the idempotency key, so a
// double tap never charges twice.
export const RETRY_LIMIT = 3;
`;

const CART_LOCK = `const locks = new Map<string, Promise<unknown>>();

/** Runs \`work\` once at a time per cart. */
export async function withCartLock<T>(cartId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(cartId) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(cartId, next);
  try {
    return await next;
  } finally {
    if (locks.get(cartId) === next) locks.delete(cartId);
  }
}
`;

const README = `# acme-web

The storefront for Acme. Vite, React 19 and a small Node API.

## Run it

\`\`\`
pnpm install
pnpm dev     # http://localhost:5173
\`\`\`

## Checkout

- One payment per cart: \`withCartLock\` holds the cart while it is charged.
- Prices come from \`pricing.ts\`; sale rules live in [docs/sales.md](docs/sales.md).

## Tests

\`pnpm test\` runs the unit tests. \`pnpm e2e\` drives the checkout in Chromium.
`;

const PACKAGE_JSON = `{
  "name": "acme-web",
  "private": true,
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "e2e": "playwright test"
  }
}
`;

/** Each sample file's text, or its size for one that stays on the computer. */
const FILES: Record<string, string | number> = {
  '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm test\n',
  'dist/app.min.js': 3_565_158,
  'public/favicon.ico': 4_286,
  'src/checkout/cartLock.ts': CART_LOCK,
  'src/checkout/index.ts': 'export { submitOrder } from \'./submitOrder\';\n',
  'src/checkout/pricing.ts': 'export function priceCart(cart: { items: Array<{ price: number }> }): number {\n  return cart.items.reduce((sum, item) => sum + item.price, 0);\n}\n',
  'src/checkout/submitOrder.ts': SUBMIT_ORDER,
  'src/checkout/submitOrder.test.ts': 'import { describe, it } from \'vitest\';\n\ndescribe(\'submitOrder\', () => {\n  it(\'charges a cart once\', async () => {});\n});\n',
  'src/components/Cart.tsx': 'export function Cart() {\n  return <aside>Cart</aside>;\n}\n',
  'tests/checkout.test.ts': 'import { test } from \'@playwright/test\';\n\ntest(\'pays once\', async () => {});\n',
  'package.json': PACKAGE_JSON,
  'README.md': README,
};

const byteLength = (value: string | number) => (typeof value === 'number' ? value : value.length);

/** `file:list` for the sample worktree: folders first, then files, by name. */
export function demoFolder(path: string): { success: true; files: Array<{ name: string; path: string; isDirectory: boolean; size?: number }> } {
  const prefix = path ? `${path}/` : '';
  const entries = new Map<string, { name: string; path: string; isDirectory: boolean; size?: number }>();
  for (const [file, content] of Object.entries(FILES)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split('/');
    entries.set(name, rest.length > 0
      ? { name, path: `${prefix}${name}`, isDirectory: true }
      : { name, path: file, isDirectory: false, size: byteLength(content) });
  }
  const files = [...entries.values()].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  return { success: true, files };
}

/** `file:read`: the text, or the host's binary answer for a file that isn't text. */
export function demoFileText(path: string) {
  const content = FILES[path];
  if (content === undefined) return { success: false, error: `${path} is not in this sample worktree.` };
  if (typeof content === 'number') return { success: false, binary: true, error: 'Binary files cannot be edited as text' };
  return { success: true, content };
}

/** `file:search`: files and folders whose path contains the pattern. */
export function demoSearch(pattern: string) {
  const needle = pattern.toLowerCase();
  const files = Object.keys(FILES).filter(file => file.toLowerCase().includes(needle)).map(file => ({ path: file, isDirectory: false }));
  return { success: true, files };
}

const PATCHES: Record<string, string> = {
  'src/checkout/submitOrder.ts': `diff --git a/src/checkout/submitOrder.ts b/src/checkout/submitOrder.ts
--- a/src/checkout/submitOrder.ts
+++ b/src/checkout/submitOrder.ts
@@ -4,12 +4,23 @@
-export async function submitOrder(id) {
-  const cart = await db.carts.get(id);
+export async function submitOrder(cartId: string) {
+  return withCartLock(cartId, async () => {
+    const cart = await db.carts.get(cartId);
+    if (cart.status === 'paid') {
+      return { ok: true, duplicate: true };
+    }
     const total = priceCart(cart);
     await charge(cart.customerId, total);
`,
  'src/checkout/cartLock.ts': `diff --git a/src/checkout/cartLock.ts b/src/checkout/cartLock.ts
new file mode 100644
--- /dev/null
+++ b/src/checkout/cartLock.ts
@@ -0,0 +1,13 @@
${CART_LOCK.trimEnd().split('\n').map(line => `+${line}`).join('\n')}
`,
  'src/checkout/submitOrder.test.ts': `diff --git a/src/checkout/submitOrder.test.ts b/src/checkout/submitOrder.test.ts
--- a/src/checkout/submitOrder.test.ts
+++ b/src/checkout/submitOrder.test.ts
@@ -1,4 +1,6 @@
 import { describe, it } from 'vitest';
 
 describe('submitOrder', () => {
-  it('charges a cart', async () => {});
+  it('charges a cart once', async () => {});
+  it('second tab sees "paid"', async () => {});
+  it('unlocks on a declined card', async () => {});
 });
`,
};

/** `sessions:get-diff-manifest`: the sample branch's three changes, against main. */
export function demoChanges() {
  const files = [
    { path: 'src/checkout/submitOrder.ts', kind: 'modified', additions: 14, deletions: 3, isBinary: false },
    { path: 'src/checkout/cartLock.ts', kind: 'added', additions: 13, deletions: 0, isBinary: false },
    { path: 'src/checkout/submitOrder.test.ts', kind: 'modified', additions: 3, deletions: 1, isBinary: false },
  ];
  return {
    success: true,
    data: {
      scope: { kind: 'session' },
      files,
      resolvedBase: { kind: 'comparison-base', ref: 'origin/main', hash: '4f1c2aa' },
      resolvedTarget: { kind: 'working-tree' },
      stats: { additions: 30, deletions: 4, filesChanged: 3 },
    },
  };
}

/** `sessions:get-file-diff`: one sample file's patch. */
export function demoFileDiff(path: string) {
  const patch = PATCHES[path];
  if (!patch) return { success: false, error: `${path} has no changes in this sample branch.`, code: 'invalid-path' };
  return { success: true, data: { file: demoChanges().data.files.find(file => file.path === path), patch, status: 'changed' } };
}

/** `sessions:get-logs`: the sample dev server's output, as the Run script printed it. */
export function demoLogs(now: number) {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  const lines: Array<[number, 'info' | 'warn', string]> = [
    [240, 'info', '$ pnpm dev'],
    [239, 'info', ''],
    [238, 'info', '  \x1b[32mVITE v6.2.0\x1b[0m  ready in 412 ms'],
    [238, 'info', ''],
    [238, 'info', '  ➜  Local:   http://localhost:5173/'],
    [238, 'info', '  ➜  Network: use --host to expose'],
    [120, 'info', '[vite] page reload src/checkout/submitOrder.ts'],
    [82, 'info', '[api] POST /api/checkout 200 84ms'],
    [81, 'warn', '[api] POST /api/checkout 200 3ms (duplicate)'],
    [20, 'info', '[vite] hmr update /src/App.tsx'],
  ];
  return { success: true, data: lines.map(([secondsAgo, level, message]) => ({ timestamp: at(secondsAgo), level, message, source: 'Script' })) };
}
