// Run under Electron so the GPU process is the one Pane ships with:
// node_modules/.bin/electron scripts/benchmark-webgl-atlas.js
//
// Opens one xterm with the WebGL renderer and feeds it agent-style output.
// WORKLOAD=shimmer (default) repaints a 140x12 grid each frame in bright 24-bit
// colors it has not used before, the worst case of an animated gradient: the
// glyph atlas never stops growing. WORKLOAD=normal scrolls colored log lines in a
// 140x40 grid under a "Thinking…" line whose gradient cycles through a fixed
// palette, like a normal agent session. Once a second it samples GPU and
// renderer memory, frame rate, the longest frame gap, and the running count
// of atlas page merges and full resets (every glyph is thrown away and
// redrawn). On macOS memory comes from `footprint`, which includes graphics
// memory that Electron's working-set numbers leave out.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SECONDS = Number(process.env.DURATION ?? 90);
const WORKLOAD = process.env.WORKLOAD ?? 'shimmer';
const XTERM_DIR = path.join(__dirname, '../frontend/node_modules/@xterm');
// Point at another addon-webgl build (for example an unpatched copy) to compare.
const WEBGL_ADDON = process.env.WEBGL_ADDON ?? path.join(XTERM_DIR, 'addon-webgl/lib/addon-webgl.js');
// Overrides the patched atlas page cap (px) so other sizes can be compared.
const ATLAS_CAP = process.env.ATLAS_CAP;
// Saves a WebM of the terminal canvas here, and the times of atlas resets next
// to it, to look for glyphs flashing.
const RECORD = process.env.RECORD;

// Runs in the page.
function pageMain(workload, cols, rows, record) {
  const term = new window.Terminal({ cols, rows, fontSize: 14, allowProposedApi: true });
  term.open(document.getElementById('term'));
  const addon = new window.WebglAddon.WebglAddon();
  term.loadAddon(addon);

  // Private atlas fields and methods, wrapped only for reporting.
  const counts = { merges: 0, resets: 0 };
  const recordStart = performance.now();
  window.benchResetTimes = [];
  function instrument(atlas) {
    if (!atlas || atlas.benchInstrumented) return;
    atlas.benchInstrumented = true;
    for (const [method, key] of [['_mergePages', 'merges'], ['_evictAllPages', 'resets'], ['clearTexture', 'resets']]) {
      const original = atlas[method].bind(atlas);
      atlas[method] = (...args) => {
        counts[key] += 1;
        if (key === 'resets') window.benchResetTimes.push(Math.round(performance.now() - recordStart));
        return original(...args);
      };
    }
  }
  const atlas = () => addon._renderer?._charAtlas;
  instrument(atlas());
  if (record) {
    const chunks = [];
    const recorder = new MediaRecorder(addon._renderer._canvas.captureStream(60), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 20e6 });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start(1000);
    window.benchStopRecording = () => new Promise((resolve) => {
      recorder.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        resolve(btoa(binary));
      };
      recorder.stop();
    });
  }

  let frames = 0;
  let lastFrameAt = performance.now();
  let longestFrameMs = 0;
  window.benchStats = () => {
    instrument(atlas());
    const stats = { frames, longestFrameMs: Math.round(longestFrameMs), ...counts, pages: (atlas()?.pages ?? []).map((p) => p.canvas.width) };
    frames = 0;
    longestFrameMs = 0;
    return stats;
  };

  const thinking = '✻ Thinking… reticulating splines (esc to interrupt)';
  const words = 'const result = await fetch(url, { method: "POST" }); if (!result.ok) throw new Error(status);'.split(' ');
  let tick = 0;
  function shimmerFrame() {
    let out = '\x1b[H';
    for (let row = 0; row < rows; row += 1) {
      out += `\x1b[${row + 1};1H`;
      for (let col = 0; col < cols; col += 1) {
        // Walk 2M bright colors (every channel 128-255) so colors don't repeat
        // for minutes, and a dark cell in a recording can only be a dropped glyph.
        const color = ((tick * rows + row) * cols + col) * 7919 % 0x200000;
        out += `\x1b[38;2;${128 + (color >> 14)};${128 + ((color >> 7) & 127)};${128 + (color & 127)}m${thinking[(col + row) % thinking.length]}`;
      }
    }
    return out + '\x1b[0m';
  }
  function normalFrame() {
    // Two log lines a frame in the 256-color palette, a truecolor diff line now
    // and then, and a status line swept by a 32-step orange gradient.
    let out = `\x1b[${rows - 1};1H\r\n`;
    for (let i = 0; i < 2; i += 1) {
      const n = tick * 2 + i;
      out += `\x1b[38;5;${n % 216 + 16}m${words[n % words.length]}\x1b[0m ${words.slice(0, 8 + n % 8).join(' ')}\r\n`;
    }
    if (tick % 30 === 0) out += '\x1b[48;2;40;80;40m+ added line\x1b[0m \x1b[48;2;90;30;30m- removed line\x1b[0m\r\n';
    out += `\x1b[${rows};1H`;
    for (let i = 0; i < thinking.length; i += 1) {
      const step = Math.abs(((i - tick) % 32 + 32) % 32 - 16) / 16;
      out += `\x1b[38;2;${215 + Math.round(40 * step)};${119 + Math.round(90 * step)};${87 + Math.round(90 * step)}m${thinking[i]}`;
    }
    return out + '\x1b[0m';
  }
  function frame(now) {
    longestFrameMs = Math.max(longestFrameMs, now - lastFrameAt);
    lastFrameAt = now;
    term.write(workload === 'normal' ? normalFrame() : shimmerFrame());
    tick += 1;
    frames += 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const UNIT_MB = { KB: 1 / 1024, MB: 1, GB: 1024 };

// One `footprint` call for all the pids, so sampling blocks the main process once.
function footprintMb(pids) {
  const output = execFileSync('footprint', pids.flatMap((pid) => ['-p', String(pid)]), { encoding: 'utf8' });
  const byPid = {};
  for (const match of output.matchAll(/\[(\d+)\]: .*Footprint: ([\d.]+) (KB|MB|GB)/g)) {
    byPid[match[1]] = Math.round(Number(match[2]) * UNIT_MB[match[3]]);
  }
  return byPid;
}

function memoryMb() {
  const metrics = app.getAppMetrics().filter((metric) => metric.type === 'GPU' || metric.type === 'Tab');
  const footprints = process.platform === 'darwin' ? footprintMb(metrics.map((metric) => metric.pid)) : {};
  const byType = {};
  for (const metric of metrics) {
    // privateBytes is Windows-only; workingSetSize is reported everywhere.
    const mb = footprints[metric.pid] ?? Math.round((metric.memory.privateBytes ?? metric.memory.workingSetSize) / 1024);
    byType[metric.type] = (byType[metric.type] ?? 0) + mb;
  }
  return byType;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => console.log('[page]', event.message));
  await win.loadURL('data:text/html,<body style="margin:0;background:black"><div id="term"></div></body>');
  const css = fs.readFileSync(path.join(XTERM_DIR, 'xterm/css/xterm.css'), 'utf8');
  await win.webContents.insertCSS(css);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(XTERM_DIR, 'xterm/lib/xterm.js'), 'utf8'));
  let addonSource = fs.readFileSync(WEBGL_ADDON, 'utf8');
  if (ATLAS_CAP) addonSource = addonSource.replaceAll('Math.min(4096,', `Math.min(${Number(ATLAS_CAP)},`);
  await win.webContents.executeJavaScript(addonSource);
  await win.webContents.executeJavaScript(`try { (${pageMain})(${JSON.stringify(WORKLOAD)}, 140, ${WORKLOAD === 'normal' ? 40 : 12}, ${Boolean(RECORD)}) } catch (e) { console.error(e.stack) }`);

  const samples = [];
  const started = Date.now();
  let last = started;
  while (Date.now() - started < SECONDS * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mem = memoryMb();
    const stats = await win.webContents.executeJavaScript('window.benchStats()');
    const now = Date.now();
    const fps = Math.round(stats.frames / ((now - last) / 1000));
    last = now;
    samples.push({ t: (now - started) / 1000, gpu: mem.GPU ?? 0, renderer: mem.Tab ?? 0, fps, ...stats });
    console.log(`t=${Math.round((now - started) / 1000)}s gpu=${mem.GPU ?? 0}MB renderer=${mem.Tab ?? 0}MB fps=${fps} ` +
      `longestFrame=${stats.longestFrameMs}ms totalMerges=${stats.merges} totalResets=${stats.resets} atlasPages=${stats.pages.join(',')}`);
  }
  // Steady state: the second half of the run.
  const steady = samples.filter((s) => s.t >= SECONDS / 2);
  console.log(JSON.stringify({
    workload: WORKLOAD,
    atlasCap: ATLAS_CAP ?? 'bundle',
    seconds: SECONDS,
    peakGpuMb: Math.max(...samples.map((s) => s.gpu)),
    steadyGpuMb: median(steady.map((s) => s.gpu)),
    peakRendererMb: Math.max(...samples.map((s) => s.renderer)),
    merges: samples.at(-1).merges,
    resets: samples.at(-1).resets,
    medianFps: median(samples.map((s) => s.fps)),
    longestFrameMs: Math.max(...samples.map((s) => s.longestFrameMs)),
    largestPage: Math.max(...samples.flatMap((s) => s.pages)),
  }));
  if (RECORD) {
    fs.writeFileSync(RECORD, Buffer.from(await win.webContents.executeJavaScript('window.benchStopRecording()'), 'base64'));
    fs.writeFileSync(`${RECORD}.resets.json`, JSON.stringify(await win.webContents.executeJavaScript('window.benchResetTimes')));
  }
  app.quit();
});
