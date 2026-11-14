#!/usr/bin/env node
/* global process, setTimeout */
// A fake terminal agent for Session activity journeys: it plays a recorded Claude Code or Codex
// screen capture (main/src/services/agentStatus/__fixtures__/screens) back to its terminal with
// the recorded timing, so Pane's real detection reads it as it read the real agent. A test makes
// a terminal tab run it with the tab's agentType set to the captured agent.
//
//   node fakeTerminalAgent.mjs <fixture.json> [--from MARK] [--to MARK] [--loop MARK:MARK:SECONDS]
//
// --from plays everything before MARK at once (so the screen is right) and then plays on in real
// time; --to stops playing at MARK and holds the last screen, with no output, until killed (a
// frozen screen); --loop plays the frames between two marks over and over for SECONDS (a long
// tool call) before going on. Keys typed into it are ignored.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const fixture = JSON.parse(readFileSync(argv[0], 'utf8'));
const markAt = label => {
  if (label === undefined) return undefined;
  const mark = fixture.marks.find(entry => entry.label === label);
  if (!mark) throw new Error(`The fixture ${argv[0]} has no mark "${label}". Marks: ${fixture.marks.map(entry => entry.label).join(', ')}.`);
  return mark.t;
};
const from = markAt(option('--from')) ?? 0;
const to = markAt(option('--to')) ?? Infinity;
const loop = option('--loop')?.split(':');
const loopFrom = loop ? markAt(loop[0]) : undefined;
const loopTo = loop ? markAt(loop[1]) : undefined;
const loopFor = loop ? Number(loop[2]) * 1000 : 0;

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => undefined);

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const frames = fixture.frames;

async function play(start, end) {
  const began = Date.now();
  for (const frame of frames) {
    if (frame.t < start || frame.t >= end) continue;
    await sleep(frame.t - start - (Date.now() - began));
    process.stdout.write(frame.data);
  }
  await sleep(end - start - (Date.now() - began));
}

// The screen as it stood at --from, at once.
for (const frame of frames) if (frame.t < from) process.stdout.write(frame.data);
if (loop && loopFrom !== undefined && loopTo !== undefined && loopFrom >= from) {
  await play(from, loopFrom);
  const until = Date.now() + loopFor;
  while (Date.now() < until) await play(loopFrom, loopTo);
  await play(loopTo, Math.min(to, frames.at(-1)?.t ?? 0) + 1);
} else {
  await play(from, Math.min(to, (frames.at(-1)?.t ?? 0) + 1));
}
// Hold the last screen until the tab closes.
setTimeout(() => undefined, 2 ** 31 - 1);
