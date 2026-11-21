#!/usr/bin/env node
// Prints a daily table of Pane relay usage from the relays' logs in Cloud Logging.
//
//   node relay/deploy/usage.mjs --account <gcloud account> [--project pane-pwa-preview] [--days 7]
//
// Columns, per UTC day:
//   online peak    most computers connected at once, summed over the relays (hourly samples)
//   seen 24h       computers that connected in the 24 h before the day's last sample, summed
//                  over the relays (a computer that moved regions counts once per relay)
//   new            computers whose first "computer connected" line in the logs falls that day
//   clients peak   most client devices at once (distinct computer and client address pairs)
//   per computer   clients per computer that had any, averaged over the day's samples
//
// Reads the hourly "relay usage" lines and the "computer connected" lines the relays
// already log. Cloud Logging keeps them 30 days, so "new" counts a computer the first
// time it appears in that window: the first days after logging starts count every
// computer as new.
import { execFileSync } from 'node:child_process';

const RETENTION_DAYS = 30;

function parseArgs(argv) {
  const args = { project: 'pane-pwa-preview', days: 7, account: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--account') args.account = value;
    else if (flag === '--project') args.project = value;
    else if (flag === '--days') args.days = Number(value);
    else throw new Error(`unknown argument ${flag}`);
    i += 1;
  }
  if (!args.account) throw new Error('--account is required: the gcloud account that reads logs in the project');
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > RETENTION_DAYS) {
    throw new Error(`--days takes 1 to ${RETENTION_DAYS}`);
  }
  return args;
}

function readLogs({ account, project }, text, since) {
  const filter = `resource.type="gce_instance" AND "${text}" AND timestamp>="${since.toISOString()}"`;
  const out = execFileSync(
    'gcloud',
    ['logging', 'read', filter, `--account=${account}`, `--project=${project}`, '--format=json', '--order=asc'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  return JSON.parse(out || '[]');
}

// The relay writes one JSON object a line. Depending on the logging agent, Cloud Logging
// stores it parsed (jsonPayload) or as text under message, log or textPayload.
function fields(entry) {
  const payload = entry.jsonPayload ?? {};
  for (const raw of [payload.message, payload.log, entry.textPayload]) {
    if (typeof raw === 'string' && raw.trimStart().startsWith('{')) {
      try {
        return JSON.parse(raw);
      } catch {
        // Not one of the relay's lines.
      }
    }
  }
  return payload;
}

const day = (ts) => ts.slice(0, 10);
const hour = (ts) => ts.slice(0, 13);

export function table(usageEntries, connectedEntries, days, now = new Date()) {
  const firstDay = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  // The largest sample per relay and hour: a restart's shutdown line and the hourly
  // line can share an hour.
  const samples = new Map();
  for (const entry of usageEntries) {
    const f = fields(entry);
    if (f.message !== 'relay usage') continue;
    const key = `${hour(entry.timestamp)} ${f.region}`;
    const prev = samples.get(key);
    if (!prev || f.computers >= prev.computers) samples.set(key, { ...f, timestamp: entry.timestamp });
  }
  const hours = new Map();
  const lastSeen = new Map();
  for (const s of samples.values()) {
    const h = hours.get(hour(s.timestamp)) ?? { computers: 0, clients: 0, withClients: 0 };
    h.computers += s.computers;
    h.clients += s.clients;
    h.withClients += s.computers_with_clients;
    hours.set(hour(s.timestamp), h);
    const key = `${day(s.timestamp)} ${s.region}`;
    const prev = lastSeen.get(key);
    if (!prev || s.timestamp > prev.timestamp) lastSeen.set(key, s);
  }
  const firstSeen = new Map();
  for (const entry of connectedEntries) {
    const f = fields(entry);
    if (f.message !== 'computer connected' || !f.id) continue;
    if (!firstSeen.has(f.id) || entry.timestamp < firstSeen.get(f.id)) firstSeen.set(f.id, entry.timestamp);
  }

  const rows = [];
  for (let t = new Date(`${firstDay}T00:00:00Z`); t <= now; t = new Date(t.getTime() + 86_400_000)) {
    const d = t.toISOString().slice(0, 10);
    const dayHours = [...hours].filter(([h]) => h.startsWith(d)).map(([, v]) => v);
    const clients = dayHours.reduce((n, h) => n + h.clients, 0);
    const withClients = dayHours.reduce((n, h) => n + h.withClients, 0);
    rows.push({
      day: d,
      onlinePeak: dayHours.length ? Math.max(...dayHours.map((h) => h.computers)) : null,
      seen24h: [...lastSeen].filter(([k]) => k.startsWith(d)).reduce((n, [, s]) => n + s.computers_seen_24h, 0),
      new: [...firstSeen.values()].filter((ts) => day(ts) === d).length,
      clientsPeak: dayHours.length ? Math.max(...dayHours.map((h) => h.clients)) : null,
      perComputer: withClients ? clients / withClients : null,
    });
  }
  return rows;
}

function print(rows) {
  const head = ['day', 'online peak', 'seen 24h', 'new', 'clients peak', 'per computer'];
  const body = rows.map((r) => [
    r.day,
    r.onlinePeak ?? '-',
    r.onlinePeak === null ? '-' : r.seen24h,
    r.new,
    r.clientsPeak ?? '-',
    r.perComputer === null ? '-' : r.perComputer.toFixed(1),
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  for (const row of [head, ...body]) {
    console.log(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const now = new Date();
    const start = new Date(`${new Date(now.getTime() - (args.days - 1) * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
    const usage = readLogs(args, 'relay usage', start);
    const connected = readLogs(args, 'computer connected', new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
    print(table(usage, connected, args.days, now));
  } catch (e) {
    console.error(`usage.mjs: ${e.message}`);
    process.exit(1);
  }
}
