#!/usr/bin/env node
// Prints a daily table of Pane relay usage from the "relay usage" lines each relay writes to
// Cloud Logging when it starts, once an hour and when it stops (pane-relay --usage-project).
//
//   node relay/deploy/usage.mjs --account <gcloud account> [--project pane-pwa-preview] [--days 7]
//
// Columns, per UTC day:
//   online peak    most computers connected at once, summed over the relays (hourly samples)
//   seen 24h       each relay's most computers seen in the 24 h before one of its lines that
//                  day, summed over the relays (a computer that moved regions counts once per relay)
//   clients peak   most devices reaching computers through the relays at once (distinct
//                  computer and client address pairs; same-network and Tailscale devices don't
//                  pass through a relay)
//   per computer   clients per computer that had any, averaged over the day's samples
// A * marks a day a relay started: its counts start again from zero.
// New computers aren't here: the relays keep no history across restarts. They are PostHog's
// certificate_issued events with renewal false (docs/ANALYTICS_INVARIANTS.md).
import { execFileSync } from 'node:child_process';

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const args = { project: 'pane-pwa-preview', days: 7, account: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--account') args.account = value;
    else if (flag === '--project') args.project = value;
    else if (flag === '--days') args.days = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.account) throw new Error('--account is required: the gcloud account that reads logs in the project');
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > RETENTION_DAYS) {
    throw new Error(`--days takes 1 to ${RETENTION_DAYS}`);
  }
  return args;
}

function readLines({ account, project }, since) {
  const filter = `logName="projects/${project}/logs/pane-relay-usage" AND timestamp>="${since.toISOString()}"`;
  const out = execFileSync(
    'gcloud',
    ['logging', 'read', filter, `--account=${account}`, `--project=${project}`, '--format=json', '--order=asc'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out || '[]').map((entry) => ({ ...entry.jsonPayload, timestamp: entry.timestamp }));
}

const day = (ts) => ts.slice(0, 10);
const hour = (ts) => ts.slice(0, 13);
const sum = (items, pick) => items.reduce((n, item) => n + pick(item), 0);

function table(lines, firstDay, lastDay) {
  // The largest sample per relay and hour: a restart's start line and the hourly line can share an hour.
  const samples = new Map();
  for (const line of lines) {
    const key = `${hour(line.timestamp)} ${line.region}`;
    const prev = samples.get(key);
    if (!prev || line.computers >= prev.computers) samples.set(key, line);
  }
  const rows = [];
  for (let t = Date.parse(`${firstDay}T00:00:00Z`); t <= Date.parse(`${lastDay}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    const dayLines = lines.filter((line) => day(line.timestamp) === d);
    const hours = new Map();
    for (const s of [...samples.values()].filter((line) => day(line.timestamp) === d)) {
      const h = hours.get(hour(s.timestamp)) ?? [];
      h.push(s);
      hours.set(hour(s.timestamp), h);
    }
    const perHour = [...hours.values()].map((h) => ({
      computers: sum(h, (s) => s.computers),
      clients: sum(h, (s) => s.clients),
      withClients: sum(h, (s) => s.computers_with_clients),
    }));
    const seenPerRelay = new Map();
    for (const line of dayLines) seenPerRelay.set(line.region, Math.max(seenPerRelay.get(line.region) ?? 0, line.computers_seen_24h));
    const withClients = sum(perHour, (h) => h.withClients);
    rows.push({
      day: d,
      samples: perHour.length,
      onlinePeak: Math.max(0, ...perHour.map((h) => h.computers)),
      seen24h: sum([...seenPerRelay.values()], (n) => n),
      clientsPeak: Math.max(0, ...perHour.map((h) => h.clients)),
      perComputer: withClients ? sum(perHour, (h) => h.clients) / withClients : null,
      restarted: dayLines.some((line) => line.reason === 'start'),
    });
  }
  return rows;
}

function print(rows) {
  const head = ['day', 'online peak', 'seen 24h', 'clients peak', 'per computer'];
  const body = rows.map((r) => (r.samples === 0
    ? [r.day, '-', '-', '-', '-']
    : [
      r.day + (r.restarted ? ' *' : ''),
      r.onlinePeak,
      r.seen24h,
      r.clientsPeak,
      r.perComputer === null ? '-' : r.perComputer.toFixed(1),
    ].map(String)));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  for (const row of [head, ...body]) {
    console.log(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '));
  }
  if (rows.some((r) => r.restarted)) console.log('* a relay started that day: its counts started again from zero');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(Date.parse(`${today}T00:00:00Z`) - (args.days - 1) * DAY_MS).toISOString().slice(0, 10);
  print(table(readLines(args, new Date(`${firstDay}T00:00:00Z`)), firstDay, today));
} catch (e) {
  console.error(`usage.mjs: ${e.message}`);
  process.exit(1);
}
