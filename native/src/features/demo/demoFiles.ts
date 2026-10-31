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
