import { EventEmitter } from 'node:events';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { PageDriver, type BrowserPageContents, type LoginToFill } from '../main/src/services/browser/pageDriver';
import { runVerb } from '../main/src/services/browser/pageVerbs';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';

// Pane's own page driver on a real Chromium page: a saved login goes into a field of its own site,
// and nothing an agent or another screen receives holds the value (docs/BROWSER_AGENTS.md).

const SITE = 'https://bank.example';
const VALUE = 'canary-Tr0ub4dor';

interface ProtocolCommands { send(method: string, params?: JsonObject): Promise<JsonValue> }

/** The parts of Electron's WebContents the driver uses, on a Playwright page. */
class ChromiumPage extends EventEmitter {
  readonly id = 1;
  readonly devToolsWebContents = null;
  readonly debugger: BrowserPageContents['debugger'];
  readonly navigationHistory = { canGoBack: () => true, goBack: () => void this.page.goBack(), canGoForward: () => false, goForward: () => undefined };
  /** Every debugger command, as Electron would be asked for it. */
  readonly sent: string[] = [];
  private title = '';

  constructor(readonly page: Page, private readonly cdp: CDPSession) {
    super();
    const events = new EventEmitter();
    // SAFETY: the driver names protocol commands as plain strings, and Playwright sends any it is given.
    const commands = cdp as ProtocolCommands;
    this.debugger = Object.assign(events, {
      attach: () => undefined,
      isAttached: () => true,
      detach: () => undefined,
      sendCommand: (method: string, params?: JsonObject) => { this.sent.push(method); return commands.send(method, params); },
    });
    for (const event of ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed'] as const) cdp.on(event, params => events.emit('message', {}, event, params));
    page.on('dialog', () => undefined);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.emit('did-navigate'); });
    page.on('load', () => this.emit('did-stop-loading'));
  }

  /** Answers every page from `pages` by URL, and offers page-made navigations to will-navigate first, as Electron does. */
  async serve(pages: Record<string, string>): Promise<void> {
    await this.page.route('**/*', async route => {
      const url = route.request().url();
      if (route.request().isNavigationRequest() && route.request().frame() === this.page.mainFrame()) {
        let stopped = false;
        this.emit('will-navigate', { url, preventDefault: () => { stopped = true; } });
        if (stopped) { await route.abort('aborted'); return; }
      }
      const body = pages[url] ?? pages[url.split('?')[0]];
      if (body === undefined) await route.fulfill({ status: 404, body: 'no such page' });
      else await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta name="viewport" content="width=device-width">${body}` });
    });
  }

  isDestroyed(): boolean { return false; }
  getURL(): string { return this.page.url(); }
  getTitle(): string { return this.title; }
  isLoading(): boolean { return false; }
  isDevToolsOpened(): boolean { return false; }
  setBackgroundThrottling(): void { /* Chromium keeps the page in front here. */ }
  setAudioMuted(): void { /* Nothing plays. */ }
  async loadURL(url: string): Promise<void> { await this.page.goto(url); }
  reload(): void { void this.page.reload(); }
  async insertText(text: string): Promise<void> { await this.page.keyboard.insertText(text); }
  sendInputEvent(): void { /* Keys are not under test. */ }
  async capturePage() {
    const png = await this.page.screenshot();
    return { toPNG: () => png, getSize: () => ({ width: 1280, height: 720 }) };
  }
  async executeJavaScriptInIsolatedWorld(_world: number, [{ code }]: { code: string }[]): Promise<JsonValue> {
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'pane' });
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: code, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
}

interface Tab { contents: ChromiumPage; driver: PageDriver; uses: string[] }

async function tab(page: Page, pages: Record<string, string>): Promise<Tab> {
  const contents = new ChromiumPage(page, await page.context().newCDPSession(page));
  await contents.serve(pages);
  return { contents, driver: new PageDriver(contents), uses: [] };
}

function login(t: Tab, overrides: Partial<LoginToFill> & { value?: string } = {}): LoginToFill {
  const sites = overrides.sites ?? [SITE];
  return {
    key: 'bank/PASSWORD',
    sites,
    read: overrides.read ?? (async () => ({ value: overrides.value ?? VALUE, sites })),
    record: overrides.record ?? (async site => { t.uses.push(site); }),
  };
}

/** The ref of the first line of a fresh snapshot that names `text`. */
async function refOf(t: Tab, text: string): Promise<string> {
  const { snapshot } = await t.driver.snapshot();
  const ref = snapshot.split('\n').find(line => line.includes(text) && line.includes('ref='))?.match(/ref=(e\d+)/)?.[1];
  if (!ref) throw new Error(`no ref for ${text} in:\n${snapshot}`);
  return ref;
}

async function fill(t: Tab, label: string, saved: LoginToFill) {
  return runVerb(t.driver, t.contents, { verb: 'fill', ref: await refOf(t, label), login: saved });
}

const FORM = '<title>Sign in</title><form method="post"><label>Password <input id="p" type="password"></label><label>Code <input id="c"></label><button>Go</button></form>';

test.describe('filling a saved login', () => {
  test('puts the value in the page as typing would, and gives it to nothing else', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: `${FORM}<script>window.heard=[];for (const type of ['keydown','input','keyup','change']) document.querySelector('#p').addEventListener(type, e => window.heard.push(type));</script>` });
    await page.goto(SITE);
    const outcome = await fill(t, 'Password', login(t));
    // The page itself got it (read here as the page's own script would).
    expect(await page.locator('#p').inputValue()).toBe(VALUE);
    expect(await page.evaluate('window.heard')).toEqual(['keydown', 'input', 'keyup', 'change']);
    expect(t.uses).toEqual([SITE]);
    expect(outcome.note).toContain('Filled bank/PASSWORD');
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    expect(JSON.stringify(await t.driver.snapshot())).not.toContain(VALUE);
    // Everything else on the page is withheld too: the page may have copied the login into another field.
    await page.locator('#c').evaluate((el: HTMLInputElement, value) => { el.value = value; }, VALUE);
    const { snapshot } = await t.driver.snapshot();
    expect(snapshot).toContain('textbox "Code"');
    expect(snapshot).not.toContain(VALUE);
  });

  test('runs no script on the filled page until the tab loads a new one, whichever way it gets there', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: FORM, [`${SITE}/somewhere`]: FORM, [`${SITE}/home`]: '<title>Home</title><p>Welcome</p>' });
    await page.goto(SITE);
    await fill(t, 'Code', login(t));
    await expect(t.driver.evaluate('document.querySelector("#c").value', undefined)).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_ON_PAGE' });
    // Moving within the document changes nothing: it still holds the login.
    await page.evaluate('history.pushState({}, "", "/somewhere")');
    await expect(t.driver.evaluate('1', undefined)).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_ON_PAGE' });
    await t.driver.navigate({ url: `${SITE}/home` });
    await expect(t.driver.evaluate('document.title', undefined)).resolves.toMatchObject({ value: 'Home' });
    // Going back neither restores the field's value nor hands it over.
    await page.goBack();
    await page.waitForLoadState();
    await page.locator('#c').waitFor();
    const back = await t.driver.evaluate('document.querySelector("#c").value', undefined).catch((error: { code: string }) => error.code);
    expect([{ value: '', truncated: false }, 'ERR_BROWSER_LOGIN_ON_PAGE']).toContainEqual(back);
    expect(JSON.stringify(await t.driver.snapshot())).not.toContain(VALUE);
  });

  test('shows dots on screenshots and stream frames, for a plain text box the page tries to show', async ({ page }) => {
    const pin = '<title>PIN</title><style>*{caret-color:transparent}input{outline:0!important}</style><label>PIN <input id="p" inputmode="numeric"></label><script>document.querySelector("#p").addEventListener("input", () => { document.querySelector("#p").type = "text"; });</script>';
    const shots: Record<string, { shot: string; frame: string; state: JsonValue }> = {};
    for (const value of ['1111', '8888']) {
      const fresh = await page.context().newPage();
      // In front, so its pictures are of what it draws now.
      await fresh.bringToFront();
      const t = await tab(fresh, { [`${SITE}/`]: pin });
      await fresh.goto(SITE);
      await fill(t, 'PIN', login(t, { value }));
      expect(await fresh.locator('#p').inputValue()).toBe(value);
      // The page's own "show" is undone, so nothing can be copied out of it either.
      await expect(fresh.locator('#p')).toHaveAttribute('type', 'password');
      const shot = await t.driver.screenshot(false);
      const frame = await t.driver.still(90);
      shots[value] = { shot: shot.png.toString('base64'), frame: frame.data, state: null };
      await fresh.close();
    }
    expect(shots['1111'].shot).toBe(shots['8888'].shot);
    expect(shots['1111'].frame).toBe(shots['8888'].frame);
  });

  test('goes nowhere when an agent ran a script in the tab, even before another page', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: FORM });
    await page.goto(SITE);
    await t.driver.evaluate('1', undefined);
    await page.reload();
    await expect(fill(t, 'Password', login(t))).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_SCRIPTED' });
    expect(await page.locator('#p').inputValue()).toBe('');
    expect(t.uses).toEqual([]);
  });

  test('is not sent in an address: a form that submits with GET is stopped and the agent is told', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: '<form action="/in"><label>Password <input name="p" type="password"></label><button>Go</button></form>', [`${SITE}/in`]: 'in' });
    await page.goto(SITE);
    await fill(t, 'Password', login(t));
      const clicked = await runVerb(t.driver, t.contents, { verb: 'click', ref: await refOf(t, 'Go'), button: 'left', double: false });
    expect(page.url()).toBe(`${SITE}/`);
    expect(clicked.note).toContain('address that holds the saved login');
    expect(JSON.stringify(clicked)).not.toContain(VALUE);
  });
});

test.describe('only on its own site', () => {
  const PUNYCODE = 'https://xn--bnk-6cd.example';
  for (const [name, url] of [
    ['http for an https site', 'http://bank.example/'],
    ['another port', 'https://bank.example:8443/'],
    ['a subdomain', 'https://login.bank.example/'],
    ['a lookalike host', 'https://bank.example.evil.test/'],
    ['a punycode lookalike', `${PUNYCODE}/`],
    ['another site', 'https://evil.test/?next=https://bank.example/'],
  ] as const) {
    test(`refuses ${name}`, async ({ page }) => {
      const t = await tab(page, { [url.split('?')[0]]: FORM });
      await page.goto(url);
      let read = 0;
      await expect(fill(t, 'Password', login(t, { read: async () => { read += 1; return { value: VALUE, sites: [SITE] }; } }))).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_SITE' });
      // Refused before the value is even read.
      expect(read).toBe(0);
      expect(await page.locator('#p').inputValue()).toBe('');
    });
  }

  test('takes the stored sites over the listed ones, so a widened list fills nothing', async ({ page }) => {
    const t = await tab(page, { 'https://evil.test/': FORM });
    await page.goto('https://evil.test/');
    const widened = login(t, { sites: [SITE, 'https://evil.test'], read: async () => ({ value: VALUE, sites: [SITE] }) });
    await expect(fill(t, 'Password', widened)).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_SITE' });
    expect(await page.locator('#p').inputValue()).toBe('');
    expect(t.uses).toEqual([]);
  });

  test('sends nothing when the page redirects to another site, or reloads, between the check and the fill', async ({ page }) => {
    const spy = `${FORM}<script>window.got=[];document.addEventListener('input', e => window.got.push(e.target.value), true);</script>`;
    for (const destination of ['https://evil.test/', `${SITE}/`]) {
      const fresh = await page.context().newPage();
      // In front, so its pictures are of what it draws now.
      await fresh.bringToFront();
      const t = await tab(fresh, { [`${SITE}/`]: spy, 'https://evil.test/': spy });
      await fresh.goto(SITE);
      const moved = login(t, { record: async () => { await fresh.goto(destination); } });
      const outcome = await fill(t, 'Password', moved).catch((error: { code: string }) => error);
      // Pane never claims a fill it can't know of.
      expect(JSON.stringify(outcome)).not.toContain('Filled bank/PASSWORD.');
      expect(await fresh.evaluate('window.got')).toEqual([]);
      expect(await fresh.locator('#p').inputValue()).toBe('');
      expect(JSON.stringify(outcome)).not.toContain(VALUE);
      await fresh.close();
    }
  });

  test('never goes into a frame of another site, nor onto a page that only frames the login site', async ({ page }) => {
    const grabby = `${FORM}<script>window.got=[];document.addEventListener('input', e => window.got.push(e.target.value), true); setInterval(() => { window.focus(); document.querySelector('#p').focus(); }, 5);</script>`;
    const t = await tab(page, {
      [`${SITE}/`]: `${FORM}<iframe src="https://evil.test/inner" width=400 height=200></iframe>`,
      'https://evil.test/inner': grabby,
      'https://evil.test/': `<iframe src="${SITE}/" width=400 height=200></iframe>`,
    });
    await page.goto(SITE);
    // Only the top page's own fields have refs, so a frame's field can't be named at all.
    expect((await t.driver.snapshot()).snapshot.match(/textbox.*ref=/g)).toHaveLength(2);
    await fill(t, 'Password', login(t));
    const inner = page.frame({ url: 'https://evil.test/inner' });
    expect(await inner?.evaluate('window.got')).toEqual([]);
    expect(await page.locator('#p').inputValue()).toBe(VALUE);
    await page.goto('https://evil.test/');
    expect((await t.driver.snapshot()).snapshot).not.toMatch(/textbox.*ref=/);
  });

  test('refuses a sandboxed document at the login site\'s address', async ({ page }) => {
    const t = await tab(page, {});
    await page.route(`${SITE}/`, route => route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': 'sandbox allow-scripts allow-forms' }, body: FORM }));
    await page.goto(SITE);
    await expect(fill(t, 'Password', login(t))).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_SITE' });
  });
});

test.describe('only a field the person could type in', () => {
  for (const [name, html] of [
    ['a button', '<button>Target</button>'],
    ['a link', '<a href="#">Target</a>'],
    ['a checkbox', '<label>Target <input type="checkbox"></label>'],
    ['a text area', '<label>Target <textarea></textarea></label>'],
    ['an editable block', '<div contenteditable role="textbox" aria-label="Target">x</div>'],
    ['a read-only field', '<label>Target <input readonly></label>'],
    ['a disabled field', '<label>Target <input disabled></label>'],
    ['a field in a disabled fieldset', '<fieldset disabled><label>Target <input></label></fieldset>'],
    ['an inert field', '<div inert><label>Target <input></label></div>'],
    ['a transparent field', '<label>Target <input style="opacity:0"></label>'],
    ['a field in a transparent block', '<div style="opacity:0.02"><label>Target <input></label></div>'],
    ['a one pixel field', '<input aria-label="Target" style="width:1px;height:1px;padding:0;border:0">'],
    ['a field off the page', '<input aria-label="Target" style="position:absolute;left:-9999px">'],
    ['a clipped field', '<div style="position:absolute;clip-path:inset(50%)"><input aria-label="Target"></div>'],
    ['a covered field', '<input aria-label="Target"><div style="position:fixed;inset:0;background:white"></div>'],
    ['a field too short for it', '<label>Target <input maxlength="3"></label>'],
  ] as const) {
    test(`refuses ${name}`, async ({ page }) => {
      const t = await tab(page, { [`${SITE}/`]: html });
      await page.goto(SITE);
      await expect(fill(t, 'Target', login(t))).rejects.toMatchObject({ code: 'ERR_BROWSER_LOGIN_FIELD' });
      expect(await page.evaluate('[...document.querySelectorAll("input,textarea")].map(el => el.value).join("")')).not.toContain(VALUE);
    });
  }

  test('fills a field inside a shadow root and one behind its own floating label', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: '<x-field></x-field><div style="position:relative"><input id="f" aria-label="Floating"><label for="f" style="position:absolute;left:0;top:0;width:100%">Floating</label></div><script>customElements.define("x-field", class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:"open"}).innerHTML = "<label>Shadow <input type=password></label>"; } });</script>' });
    await page.goto(SITE);
    await fill(t, 'Shadow', login(t));
    await fill(t, 'Floating', login(t));
    expect(await page.evaluate('document.querySelector("x-field").shadowRoot.querySelector("input").value + document.querySelector("#f").value')).toBe(VALUE + VALUE);
  });
});

test.describe('split one-digit PIN boxes', () => {
  /** A PIN component as React's are: one state, boxes redrawn from it after each change, focus moved on, and the digits drawn. */
  const boxes = (attributes: string) => `<title>PIN</title><p>Enter your PIN</p><div id="boxes">${[1, 2, 3, 4].map(n => `<input aria-label="Digit ${n}" ${attributes} style="width:40px;height:40px">`).join('')}</div><div id="drawn"></div><p>Attempts left: 3</p>
<script>const state = ['', '', '', '']; const all = [...document.querySelectorAll('#boxes input')]; window.moves = [];
all.forEach((box, i) => box.addEventListener('input', () => { const seen = state.slice(); seen[i] = box.value; queueMicrotask(() => { seen.forEach((v, n) => { state[n] = v; }); document.querySelector('#drawn').innerHTML = state.map(v => '<span>' + v + '</span>').join(''); if (all[i + 1]) { all[i + 1].focus(); window.moves.push(i + 1); } else window.submitted = state.join(''); }); }));</script>`;
  for (const [name, attributes] of [['one character each', 'maxlength="1"'], ['narrow boxes with no limit', 'inputmode="numeric"'], ['number boxes', 'type="number" maxlength="1"']] as const) {
    test(`fills ${name}, from any box, and shows no digit`, async ({ page }) => {
      const t = await tab(page, { [`${SITE}/`]: boxes(attributes) });
      await page.goto(SITE);
      await fill(t, 'Digit 2', login(t, { value: '7402' }));
      expect(await page.evaluate('window.submitted')).toBe('7402');
      expect(await page.evaluate('window.moves')).toEqual([1, 2, 3]);
      const { snapshot } = await t.driver.snapshot();
      // The digits the component draws are withheld; the page's own numbers aren't.
      expect(snapshot).toContain('Attempts left: 3');
      expect(snapshot.replace(/Digit \d|ref=e\d+|Attempts left: 3/g, '')).not.toMatch(/\d/);
      expect(await page.locator('#drawn span').first().evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-text-security'))).toBe('disc');
      await expect(t.driver.wait({ text: '7402' }, 300)).rejects.toMatchObject({ code: 'ERR_BROWSER_WAIT_TIMEOUT' });
    });
  }

  /** Screenshots and frames of two values that differ only in their digits: the same when no digit shows. */
  async function pictures(page: Page, html: string, act: (fresh: Page, t: Tab) => Promise<void>) {
    const seen = [];
    for (const value of ['1111', '8888']) {
      const fresh = await page.context().newPage();
      // In front, so its pictures are of what it draws now.
      await fresh.bringToFront();
      const t = await tab(fresh, { [`${SITE}/`]: `<style>*{caret-color:transparent!important;outline:0!important}</style>${html}` });
      await fresh.goto(SITE);
      await fill(t, 'Digit 1', login(t, { value }));
      await act(fresh, t);
      await fresh.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      // Pictures before the snapshot, which reads the page and so could set off a check of its own.
      seen.push({ shot: (await t.driver.screenshot(false)).png.toString('base64'), frame: (await t.driver.still(90)).data });
      expect((await t.driver.snapshot()).snapshot).not.toContain(value[0].repeat(2));
      // The pictures could be of a page that never got it: it did.
      expect(await fresh.evaluate('[...document.querySelectorAll("input")].map(el => el.value).join("")')).toContain(value);
      await fresh.close();
    }
    expect(seen[0]).toEqual(seen[1]);
  }
  /** Boxes whose page spreads what one is given over the rest, as a pasted or texted code is. */
  const spreading = (first: string, rest: string, when: string) => `<div>${[1, 2, 3, 4].map(n => `<input aria-label="Digit ${n}" ${n === 1 ? first : rest}>`).join('')}</div>
<script>const all = [...document.querySelectorAll('input')]; all[0].addEventListener('input', () => { const code = all[0].value; if (code.length > 1) ${when}(() => all.forEach((box, i) => { box.value = code[i]; })); });</script>`;
  for (const [name, html] of [
    ['a first box that takes the whole code', spreading('maxlength="4"', 'maxlength="1"', 'queueMicrotask')],
    ['wide boxes spread at once', spreading('style="width:200px"', 'style="width:200px"', 'queueMicrotask')],
    ['wide boxes spread a moment later', spreading('style="width:200px"', 'style="width:200px"', '(f => setTimeout(f, 120))')],
    ['wide boxes spread long after, with no event', spreading('style="width:200px"', 'style="width:200px"', '(f => setTimeout(f, 2500))')],
  ] as const) {
    test(`shows no digit in a picture of ${name}`, async ({ page }) => {
      await pictures(page, html, async fresh => { await fresh.waitForTimeout(name.includes('long after') ? 2_700 : 250); });
    });
  }

  test('shows no digit when the page draws the filled field, or its boxes, again', async ({ page }) => {
    const redraw = '<script>function again() { const old = [...document.querySelectorAll("input")]; const kept = old.map(el => el.value); document.querySelector("#f").textContent = "Signing in"; setTimeout(() => { document.querySelector("#f").innerHTML = kept.map((v, i) => "<input aria-label=\'Digit " + (i + 1) + "\' style=\'width:40px;height:40px\'>").join(""); setTimeout(() => document.querySelectorAll("input").forEach((el, i) => { el.value = kept[i]; }), window.late); }, 2300); }</script>';
    const field = (count: number) => `<div id="f">${Array.from({ length: count }, (_, i) => `<input aria-label="Digit ${i + 1}" style="width:${count === 1 ? 200 : 40}px;height:40px">`).join('')}</div>${redraw}`;
    // Its values come back with the new fields, or silently a moment after them.
    for (const [count, late] of [[1, 0], [4, 0], [1, 200]]) {
      await pictures(page, `<script>window.late = ${late}</script>${field(count)}`, async fresh => {
        await fresh.evaluate('again()');
        await fresh.waitForTimeout(2_700);
      });
    }
  });

  test('says so without the value when the boxes don\'t fit the login, or the page submits itself', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: boxes('maxlength="1"'), [`${SITE}/in`]: '<title>In</title>', [`${SITE}/auto`]: `<form method="post" action="/in"><input aria-label="Digit 1" maxlength=1><input aria-label="Digit 2" maxlength=1 oninput="this.form.submit()"></form>` });
    await page.goto(SITE);
    const refused = await fill(t, 'Digit 1', login(t, { value: '740299' })).catch((error: { code: string; message: string }) => error);
    expect(refused).toMatchObject({ code: 'ERR_BROWSER_LOGIN_FIELD', message: expect.stringMatching(/does not fit this login\. Nothing was filled/) });
    expect(await page.evaluate('[...document.querySelectorAll("input")].map(el => el.value).join("")')).toBe('');
    await page.goto(`${SITE}/auto`);
    const outcome = await fill(t, 'Digit 1', login(t, { value: '74' }));
    await expect(page).toHaveTitle('In');
    expect(JSON.stringify(outcome)).not.toContain('"74"');
  });
});

test.describe('the page after a fill', () => {
  test('keeps the refs of the snapshot before it, and text waits, working', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: '<label>Password <input id="p" type="password"></label><button style="text-transform:uppercase" onclick="this.remove(); document.querySelector(\'#out\').innerHTML = \'Welcome, <b>Alice</b>!\'"><svg width="9" height="9"><title>lock</title></svg><span>Sign</span><span> in</span></button><p id="out"></p>' });
    await page.goto(SITE);
    const { snapshot } = await t.driver.snapshot();
    const ref = (role: string) => snapshot.match(new RegExp(`${role}.*ref=(e\\d+)`))?.[1] ?? '';
    const submit = ref('button');
    await t.driver.fill(ref('textbox'), login(t));
    // The ref from before the fill is refused only when the button changed.
    await t.driver.click({ ref: submit }, 'left', false);
    await t.driver.wait({ text: 'Welcome, Alice!' }, 2_000);
  });

  test('hides what the page draws of the login, and nothing that only looks like it', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: '<div id="app"><label>PIN <input></label></div>' });
    await page.goto(SITE);
    await fill(t, 'PIN', login(t, { value: '2026' }));
    await page.evaluate('document.querySelector("#app").innerHTML = "<p>Unread <b>2</b></p><p>Cards <b>20</b></p><p>Due 4 Mar 2026</p><p>Account 99202611</p>"');
    const { snapshot } = await t.driver.snapshot();
    for (const text of ['Unread', '2', '20', 'Due 4 Mar 2026', 'Account 99202611']) expect(snapshot).toContain(text);
    expect(snapshot).not.toContain('•');
  });

  test('hides a short PIN the page quotes in a sentence, and waits still find text beside drawn digits', async ({ page }) => {
    const t = await tab(page, { [`${SITE}/`]: '<label>PIN <input id="p" style="width:200px"></label><span id="drawn"></span><p id="m"></p>' });
    await page.goto(SITE);
    await fill(t, 'PIN', login(t, { value: '1357' }));
    await page.evaluate('document.querySelector("#drawn").textContent = "1"');
    await page.waitForTimeout(2_100);
    await page.evaluate('document.querySelector("#m").innerHTML = "The code " + document.querySelector("#p").value + " is not valid. <b>Try</b> again!"');
    expect((await t.driver.snapshot()).snapshot).not.toContain('1357');
    await t.driver.wait({ text: 'Try again!' }, 2_000);
  });

  for (const value of [VALUE, 'correct horse battery']) {
    test(`hides a preview of "${value}", with or without words around it`, async ({ page }) => {
      const t = await tab(page, { [`${SITE}/`]: '<label>Password <input type="password"></label><p id="a"></p><p id="b"></p>' });
      await page.goto(SITE);
      await fill(t, 'Password', login(t, { value }));
      await page.waitForTimeout(2_100);
      await page.evaluate(text => { const [a, b] = document.querySelectorAll('p'); a.textContent = text; b.textContent = `You typed ${text}.`; }, value);
      const { snapshot } = await t.driver.snapshot();
      expect(snapshot).not.toContain(value);
      expect(await page.evaluate('[...document.querySelectorAll("p")].map(el => getComputedStyle(el).webkitTextSecurity)')).toEqual(['disc', 'disc']);
    });
  }
});

test('every debugger command a fill sends is one the driver allows, and none reaches another page', async ({ page }) => {
  const t = await tab(page, { [`${SITE}/`]: FORM });
  await page.goto(SITE);
  await fill(t, 'Password', login(t));
  expect([...new Set(t.contents.sent)].filter(method => /^(Target|Browser|Storage|Network)\./.test(method))).toEqual([]);
});
