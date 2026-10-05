/**
 * One agent connection's script process. It runs each `js` call in a context that persists
 * between calls, and reaches the desktop only through engine calls the daemon serves: raw ones as
 * `engine.call`, and through our layer as `cua`. The daemon confines this process (see
 * `ScriptHosts`), since agent code can reach its `process`.
 */
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import vm from 'node:vm';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { EngineId, EngineImage, EngineResult } from './engine';
import { imageSchema, type ChildMessage, type ParentMessage } from './scriptHostProtocol';
import { createCua } from './layer/cua';
import { codexDriver } from './layer/codexDriver';
import { cuaDriverDriver } from './layer/cuaDriverDriver';
import type { StepRecord } from './layer/driver';

// Each result goes back through the daemon to the agent's context; keep it within budget at the source.
const MAX_IMAGES = 20;
/** `image()` takes one image, or an engine result and adds all of its images. */
const imageSourceSchema = boundary.union(imageSchema, boundary.object({ images: boundary.array(imageSchema) }));
type ImageSource = EngineImage | Pick<EngineResult, 'images'>;

const holdLanesSchema = boundary.object({ pid: boundary.optional(boundary.number), clipboard: boundary.optional(boundary.boolean) });
type HoldLanes = { pid?: number; clipboard?: boolean };

const pendingCalls = new Map<number, (result: EngineResult) => void>();
let nextCallId = 1;
const pendingHolds = new Map<number, () => void>();
let nextHoldId = 1;
let output = '';
let images: EngineImage[] = [];

function send(message: ChildMessage): void {
  process.send?.(message);
}

const collector = new Writable({
  write(chunk: Buffer, _encoding, done) {
    output += chunk.toString('utf8');
    done();
  },
});
const scriptConsole = new Console({ stdout: collector, stderr: collector });

/** Adds images to this call's result, within the per-call limit. */
function addImages(added: EngineImage[]): void {
  if (images.length + added.length > MAX_IMAGES) throw new RangeError(`A js call can return at most ${MAX_IMAGES} images`);
  images.push(...added);
}

/**
 * Runs `fn` while no other agent's engine calls reach the app (`pid`), or the clipboard, so an
 * action made of several calls (a line break between typed lines, a paste) can't be interleaved.
 */
async function holdLanes<T>(lanes: HoldLanes, fn: () => Promise<T>): Promise<T> {
  const holdId = nextHoldId++;
  await new Promise<void>((held) => {
    pendingHolds.set(holdId, held);
    send({ type: 'hold', holdId, pid: lanes.pid, clipboard: lanes.clipboard === true });
  });
  try {
    return await fn();
  } finally {
    send({ type: 'release', holdId });
  }
}

/** Keeps the message and the frames in the agent's code, not the host's. */
function scriptFrames(stack: string): string {
  return stack.split('\n').filter((line) => !/^\s+at /.test(line) || /[ (]js:\d/.test(line)).join('\n');
}

function callEngine(tool: string, args: JsonObject): Promise<EngineResult> {
  const message: ChildMessage = { type: 'call', callId: nextCallId++, tool, args };
  return new Promise((resolve) => {
    pendingCalls.set(message.callId, resolve);
    send(message);
  });
}

/** Our layer reports each action here; the daemon saves it for the session's replay. */
function recordStep(step: StepRecord | JsonObject): void {
  // A JSON round trip drops `undefined` fields, such as a missing screenshot.
  send({ type: 'step', step: decodeBoundary(JSON.parse(JSON.stringify(step)), boundary.jsonObject) });
}

const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';

/** One layer per engine, so ids and diffs stay with the engine that made them if Auto switches engines. */
const layers = new Map<EngineId, ReturnType<typeof createCua>>();
function layerFor(engine: EngineId): ReturnType<typeof createCua> {
  let layer = layers.get(engine);
  if (!layer) {
    layer = createCua({
      driver: engine === 'codex' ? codexDriver(callEngine, platform) : cuaDriverDriver(callEngine, platform),
      write: (text) => {
        output += `${text}\n`;
      },
      emitImage: (image) => addImages([image]),
      recordStep,
      holdLanes,
    });
    layers.set(engine, layer);
  }
  return layer;
}

const context = vm.createContext({
  cua: undefined,
  engine: {
    // Scripts are untyped, so both arguments are parsed before they leave this process.
    call(tool: string, args: JsonObject = {}): Promise<EngineResult> {
      return callEngine(decodeBoundary(tool, boundary.nonEmptyString), decodeBoundary(args, boundary.jsonObject));
    },
    hold<T>(lanes: HoldLanes, fn: () => Promise<T>): Promise<T> {
      return holdLanes(decodeBoundary(lanes, holdLanesSchema), fn);
    },
  },
  recordStep,
  image(source: ImageSource): void {
    const parsed = decodeBoundary(source, imageSourceSchema);
    const added = 'images' in parsed ? parsed.images : [parsed];
    if (added.length === 0) throw new TypeError('image() got an engine result with no images');
    addImages(added);
  },
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  console: scriptConsole,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  TextEncoder,
  TextDecoder,
});

async function run(runId: number, code: string, maxOutputChars: number, engine: EngineId): Promise<void> {
  output = '';
  images = [];
  const layer = layerFor(engine);
  layer.beginRun();
  context.cua = layer.cua;
  let ok = true;
  try {
    // An async body allows top-level await and `return`. State that should outlive the call goes on globalThis.
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'js', lineOffset: -1 });
    const value: unknown = await script.runInContext(context);
    // Strings come back as written, JSON as JSON, anything else as Node prints it.
    const text = decodeOptionalBoundary(value, boundary.string);
    const json = text === undefined ? decodeOptionalBoundary(value, boundary.json) : undefined;
    if (text !== undefined) output += text;
    else if (json !== undefined) output += JSON.stringify(json, null, 2);
    else if (value !== undefined) output += inspect(value, { depth: null });
  } catch (error) {
    ok = false;
    // inspect() prints the stack of errors from the script's own realm, where `instanceof Error` fails.
    output += scriptFrames(inspect(error));
  }
  const text = output.trimEnd();
  const capped = text.length <= maxOutputChars
    ? text
    : `${text.slice(0, maxOutputChars)}\n[output truncated: ${text.length - maxOutputChars} more characters]`;
  send({ type: 'done', runId, ok, text: capped, images });
}

process.on('message', (message: ParentMessage) => {
  if (message.type === 'run') {
    void run(message.runId, message.code, message.maxOutputChars, message.engine);
    return;
  }
  if (message.type === 'held') {
    pendingHolds.get(message.holdId)?.();
    pendingHolds.delete(message.holdId);
    return;
  }
  const resolve = pendingCalls.get(message.callId);
  pendingCalls.delete(message.callId);
  resolve?.(message.result);
});
// A script can leave timers or promises behind; the host decides when this process ends.
process.on('disconnect', () => process.exit(0));
