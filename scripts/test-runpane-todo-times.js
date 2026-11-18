#!/usr/bin/env node
/**
 * `runpane todos snooze --until`: the npm and Python CLIs read the same fixed time forms into the same
 * instant, across daylight-saving changes, and print and refuse them in the same words. Run on its own
 * after `pnpm --filter runpane build`, or as part of scripts/test-runpane-contract.js.
 */
const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pythonSource = path.join(rootDir, 'packages', 'runpane-py', 'src');

const HOUR = 60 * 60 * 1000;
const LA = 'America/Los_Angeles';

/** Tue 17 Nov 2026, 4:00 PM PST. */
const NOV_17_4PM = Date.UTC(2026, 10, 18, 0, 0);
/** Sat 31 Oct 2026, 12:00 PM PDT: the day before clocks go back in Los Angeles. */
const OCT_31_NOON = Date.UTC(2026, 9, 31, 19, 0);
/** Sat 13 Mar 2027, 12:00 PM PST: the day before clocks go forward in Los Angeles. */
const MAR_13_NOON = Date.UTC(2027, 2, 13, 20, 0);
/** Sat 28 Mar 2026, 12:00 PM GMT: the day before clocks go forward in London. */
const LONDON_MAR_28_NOON = Date.UTC(2026, 2, 28, 12, 0);

/** [text, now, zone, expected instant]. */
const READS = [
  // The spec's example: tomorrow from Tuesday afternoon is Wednesday 9:00 AM, 17 hours away.
  ['tomorrow', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['Tomorrow 14:30', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 22, 30)],
  ['tomorrow at 7:05', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 15, 5)],
  ['wed 14:30', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 22, 30)],
  ['fri 10am', NOV_17_4PM, LA, Date.UTC(2026, 10, 20, 18, 0)],
  ['friday 4:15 pm', NOV_17_4PM, LA, Date.UTC(2026, 10, 21, 0, 15)],
  // A weekday is the next one, never today.
  ['tuesday', NOV_17_4PM, LA, Date.UTC(2026, 10, 24, 17, 0)],
  ['monday', NOV_17_4PM, LA, Date.UTC(2026, 10, 23, 17, 0)],
  // ISO 8601, with and without an offset; a date alone is 9:00 AM that day.
  ['2026-11-18T09:00', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['2026-11-18 09:00', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['2026-11-18 09:00-08:00', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['2026-11-18T09:00:00+0100', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 8, 0)],
  ['2026-11-18T17:00:00.000Z', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['2026-11-18 17:00z', NOV_17_4PM, LA, Date.UTC(2026, 10, 18, 17, 0)],
  ['2026-11-20', NOV_17_4PM, LA, Date.UTC(2026, 10, 20, 17, 0)],
  // Durations, optionally after "in".
  ['45m', NOV_17_4PM, LA, NOV_17_4PM + 45 * 60 * 1000],
  ['in 2h', NOV_17_4PM, LA, NOV_17_4PM + 2 * HOUR],
  ['in 2 hours', NOV_17_4PM, LA, NOV_17_4PM + 2 * HOUR],
  ['3d', NOV_17_4PM, LA, NOV_17_4PM + 72 * HOUR],
  ['  IN   90  MIN ', NOV_17_4PM, LA, NOV_17_4PM + 90 * 60 * 1000],
  // Clocks go back on Sun 1 Nov: tomorrow is still 9:00 AM local (now PST), and 24h is 11:00 AM.
  ['tomorrow', OCT_31_NOON, LA, Date.UTC(2026, 10, 1, 17, 0)],
  ['monday', OCT_31_NOON, LA, Date.UTC(2026, 10, 2, 17, 0)],
  ['24h', OCT_31_NOON, LA, OCT_31_NOON + 24 * HOUR],
  // 1:30 AM happens twice that night: the first (PDT) one.
  ['2026-11-01 01:30', OCT_31_NOON, LA, Date.UTC(2026, 10, 1, 8, 30)],
  // Clocks go forward on Sun 14 Mar 2027: tomorrow is 9:00 AM PDT; 2:30 AM doesn't exist and reads as 3:30 AM PDT.
  ['tomorrow', MAR_13_NOON, LA, Date.UTC(2027, 2, 14, 16, 0)],
  ['2027-03-14 02:30', MAR_13_NOON, LA, Date.UTC(2027, 2, 14, 10, 30)],
  ['sun', MAR_13_NOON, LA, Date.UTC(2027, 2, 14, 16, 0)],
  ['tomorrow', LONDON_MAR_28_NOON, 'Europe/London', Date.UTC(2026, 2, 29, 8, 0)],
  ['tomorrow', NOV_17_4PM, 'Asia/Kolkata', Date.UTC(2026, 10, 19, 3, 30)],
  ['tomorrow', NOV_17_4PM, 'UTC', Date.UTC(2026, 10, 19, 9, 0)],
];

/** [text, now, zone, code]: each is refused before anything is sent. */
const REFUSALS = [
  ['next blue moon', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['400d', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['2028-01-01', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['2026-02-30', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['2026-11-18 24:00', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['tomorrow 25:00', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['tomorrow 13pm', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['tomorrow 9', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['2026-11-18 09:00+15:00', NOV_17_4PM, LA, 'todo_snooze_time'],
  ['2026-11-16', NOV_17_4PM, LA, 'todo_snooze_past'],
  ['2026-11-17T23:59Z', NOV_17_4PM, LA, 'todo_snooze_past'],
  ['0m', NOV_17_4PM, LA, 'todo_snooze_past'],
];

/** [instant, zone, expected]. */
const FORMATS = [
  [Date.UTC(2026, 10, 18, 17, 0), LA, 'Wed 18 Nov 2026, 9:00 AM PST'],
  [Date.UTC(2026, 6, 4, 19, 5), LA, 'Sat 4 Jul 2026, 12:05 PM PDT'],
  [Date.UTC(2026, 10, 18, 7, 0), LA, 'Tue 17 Nov 2026, 11:00 PM PST'],
  [Date.UTC(2026, 10, 18, 8, 0), LA, 'Wed 18 Nov 2026, 12:00 AM PST'],
  [Date.UTC(2026, 6, 4, 8, 0), 'Europe/London', 'Sat 4 Jul 2026, 9:00 AM GMT+1'],
  [Date.UTC(2026, 0, 4, 9, 0), 'Europe/London', 'Sun 4 Jan 2026, 9:00 AM GMT'],
  [Date.UTC(2026, 10, 19, 3, 30), 'Asia/Kolkata', 'Thu 19 Nov 2026, 9:00 AM GMT+5:30'],
  [Date.UTC(2026, 10, 19, 1, 0), 'Asia/Shanghai', 'Thu 19 Nov 2026, 9:00 AM GMT+8'],
  [Date.UTC(2026, 10, 18, 12, 0), 'America/Sao_Paulo', 'Wed 18 Nov 2026, 9:00 AM GMT-3'],
  [Date.UTC(2026, 10, 18, 14, 0), 'America/New_York', 'Wed 18 Nov 2026, 9:00 AM EST'],
  [Date.UTC(2026, 10, 18, 9, 0), 'UTC', 'Wed 18 Nov 2026, 9:00 AM UTC'],
];

/** [instant, now, expected]. */
const RELATIVE = [
  [NOV_17_4PM + 17 * HOUR, NOV_17_4PM, 'in 17h'],
  [NOV_17_4PM + 45 * 60 * 1000, NOV_17_4PM, 'in 45m'],
  [NOV_17_4PM + 20 * 1000, NOV_17_4PM, 'in 1m'],
  [NOV_17_4PM + 59 * 60 * 1000 + 40 * 1000, NOV_17_4PM, 'in 1h'],
  [NOV_17_4PM + 47 * HOUR, NOV_17_4PM, 'in 47h'],
  [NOV_17_4PM + 72 * HOUR, NOV_17_4PM, 'in 3d'],
  [NOV_17_4PM, NOV_17_4PM, 'due now'],
  [NOV_17_4PM - HOUR, NOV_17_4PM, 'due now'],
];

function findPython() {
  for (const command of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      childProcess.execFileSync(command, ['--version'], { stdio: 'ignore' });
      return command;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not find a Python executable. Set PYTHON to override.');
}

function nodeResults(times) {
  const reads = READS.map(([text, now, zone]) => times.readSnoozeTime(text, now, zone));
  const refusals = REFUSALS.map(([text, now, zone]) => {
    try {
      times.readSnoozeTime(text, now, zone);
      return null;
    } catch (error) {
      return { code: error.code, message: error.message, next: error.next ?? null };
    }
  });
  const formats = FORMATS.map(([at, zone]) => times.formatSnoozeTime(at, zone));
  const relative = RELATIVE.map(([at, now]) => times.formatUntil(at, now));
  return { reads, refusals, formats, relative };
}

function pythonResults() {
  const source = `
import json
import sys
from runpane import todo_times
from runpane.notify import RunpaneError

data = json.loads(sys.stdin.read())
reads = [todo_times.read_snooze_time(text, now, zone) for text, now, zone, _ in data["reads"]]
refusals = []
for text, now, zone, _ in data["refusals"]:
    try:
        todo_times.read_snooze_time(text, now, zone)
        refusals.append(None)
    except RunpaneError as error:
        refusals.append({"code": error.code, "message": str(error), "next": error.next})
formats = [todo_times.format_snooze_time(at, zone) for at, zone, _ in data["formats"]]
relative = [todo_times.format_until(at, now) for at, now, _ in data["relative"]]
zones = todo_times._zone_info("America/Los_Angeles") is not None
print(json.dumps({"reads": reads, "refusals": refusals, "formats": formats, "relative": relative, "zones": zones}))
`;
  const output = childProcess.execFileSync(findPython(), ['-c', source], {
    cwd: rootDir,
    encoding: 'utf8',
    input: JSON.stringify({ reads: READS, refusals: REFUSALS, formats: FORMATS, relative: RELATIVE }),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: pythonSource },
  });
  return JSON.parse(output);
}

function checkTodoSnoozeTimes() {
  const times = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'todoTimes.js'));
  const node = nodeResults(times);
  READS.forEach(([text, now, zone, expected], index) => {
    assert.strictEqual(node.reads[index], expected, `"${text}" in ${zone} reads ${new Date(node.reads[index]).toISOString()}, not ${new Date(expected).toISOString()}`);
  });
  REFUSALS.forEach(([text, , , code], index) => {
    const refusal = node.refusals[index];
    assert.ok(refusal, `"${text}" is refused`);
    assert.strictEqual(refusal.code, code, `"${text}" is refused with ${code}`);
    assert.match(refusal.message, /Nothing was changed\.$/, `"${text}": ${refusal.message}`);
    assert.ok(refusal.next, `"${text}" says what to do next`);
  });
  assert.match(node.refusals[0].message, /2026-11-18T09:00.*45m, 2h, 3d.*tomorrow.*monday/, 'an unreadable time lists the forms runpane reads');
  assert.match(node.refusals[2].message, /more than a year/);
  assert.match(node.refusals[10].message, /Mon 16 Nov 2026, 9:00 AM PST/, 'a past time says when it was');
  FORMATS.forEach(([, zone, expected], index) => assert.strictEqual(node.formats[index], expected, zone));
  RELATIVE.forEach(([, , expected], index) => assert.strictEqual(node.relative[index], expected));

  // Python reads, refuses and prints the same, byte for byte.
  // Without a tz database (Python 3.8, or Windows without tzdata) Python reads every zone in the
  // system's local time, which is what its CLI uses there; only the UTC rows can be compared then.
  const python = pythonResults();
  const comparable = (zone) => python.zones || zone === 'UTC';
  const pick = (values, rows, zoneAt) => values.filter((_, index) => comparable(rows[index][zoneAt]));
  if (!python.zones) console.log('runpane todos snooze times: Python has no tz database here; compared the UTC rows only');
  assert.deepStrictEqual(pick(python.reads, READS, 2), pick(node.reads, READS, 2));
  assert.deepStrictEqual(pick(python.refusals, REFUSALS, 2), pick(node.refusals, REFUSALS, 2));
  assert.deepStrictEqual(pick(python.formats, FORMATS, 1), pick(node.formats, FORMATS, 1));
  assert.deepStrictEqual(python.relative, node.relative);
  assert.ok(pick(node.reads, READS, 2).length > 0, 'some rows are compared');
}

module.exports = { checkTodoSnoozeTimes };

if (require.main === module) {
  checkTodoSnoozeTimes();
  console.log('runpane todos snooze time checks passed');
}
