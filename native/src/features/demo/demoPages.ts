// Invented sample pages for the demo's page tabs: the shop's checkout and the Session's own pages.
// ASCII only (entities for the rest), so `btoa` can send them the way a computer sends a file.

const STYLE = `<style>
  body { margin: 0; font: 16px -apple-system, system-ui, sans-serif; color: #111827; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #e5e7eb; }
  main { padding: 16px; }
  h1 { font-size: 26px; margin: 4px 0 16px; }
  .muted { color: #6b7280; }
  .item { display: flex; align-items: center; gap: 14px; margin: 0 0 16px; }
  .swatch { width: 56px; height: 56px; border-radius: 12px; }
  .grow { flex: 1; }
  .box { background: #f3f4f6; border-radius: 14px; padding: 14px; margin: 8px 0 14px; }
  .row { display: flex; justify-content: space-between; margin: 4px 0; }
  button { width: 100%; border: 0; border-radius: 12px; padding: 14px; background: #111827; color: #fff; font: 600 17px -apple-system, system-ui, sans-serif; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
  td { padding: 10px 12px; border-top: 1px solid #e5e7eb; }
  tr:first-child td { border-top: 0; }
  .ok { color: #15803d; font-weight: 600; text-align: right; }
  .wait { color: #b45309; font-weight: 600; text-align: right; }
  .run { text-align: right; }
</style>`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;

const CHECKOUT = page('Checkout', `
<header><strong style="font-size:20px">acme</strong><span class="muted">Cart (2)</span></header>
<main>
  <h1>Checkout</h1>
  <div class="item"><div class="swatch" style="background:#fde68a"></div><div class="grow"><strong>Trail runner</strong><div class="muted">Size 10 &middot; Sand</div></div><strong>$128</strong></div>
  <div class="item"><div class="swatch" style="background:#bfdbfe"></div><div class="grow"><strong>Wool socks</strong><div class="muted">3 pack</div></div><strong>$24</strong></div>
  <div class="box">
    <div class="row"><span>Subtotal</span><span>$152.00</span></div>
    <div class="row"><span>Spring sale</span><span style="color:#15803d">&minus;$22.80</span></div>
    <div class="row"><strong>Total</strong><strong>$129.20</strong></div>
  </div>
  <button>Pay $129.20</button>
</main>`);

const STATUS = page('Spring sale launch', `
<main style="background:#faf9f6;min-height:100vh;box-sizing:border-box">
  <h1 style="margin-bottom:4px">Spring sale launch</h1>
  <p class="muted" style="margin-top:0">Session status &middot; updated 2 min ago</p>
  <table>
    <tr><td>fix-checkout-race</td><td class="ok">PR #412 ready</td></tr>
    <tr><td>add-dark-mode</td><td class="wait">Waiting on you</td></tr>
    <tr><td>upgrade-react-19</td><td class="run">Running</td></tr>
    <tr><td>rate-limit-retries</td><td class="ok">Merged</td></tr>
  </table>
  <p><strong>Next:</strong> <span class="muted">approve the migration in rate-limit-retries, then run the launch checklist.</span></p>
</main>`);

const PLAN = page('Launch plan', `
<main>
  <h1>Launch plan</h1>
  <ol>
    <li>Ship the checkout fix (one charge per cart).</li>
    <li>Pick dark-mode colors, then ship add-dark-mode.</li>
    <li>Approve the staging migration for rate-limit-retries.</li>
    <li>Run the launch checklist on Friday morning.</li>
  </ol>
</main>`);

/** The sample page for a demo tab's address: the Session's pages by file name, the shop for anything else. */
export function demoPageHtml(url: string): string {
  if (url.endsWith('/status.html')) return STATUS;
  if (url.endsWith('/plan.html')) return PLAN;
  return CHECKOUT;
}
