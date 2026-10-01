#!/usr/bin/env node
// Strict HTTPS/HTTP probe for Session port URLs, run from a tailnet device (no forwarder).
// usage: node probe.mjs [--timeout ms] [--wait-200 ms] <url>...
// Prints one JSON line per URL: status, body (first 200 chars), and for https the peer certificate
// (subject, SANs, issuer, validity) with Node's default CA check ON (rejectUnauthorized), so a
// self-signed or wrong-name certificate is an error, not a pass.
// --wait-200 ms: retry every second until the URL answers 200 or the budget runs out; reports the
// time to the first 200 (msTo200) measured from the probe's start.
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
let timeoutMs = 10_000;
let waitMs = 0;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--timeout') timeoutMs = Number(args[++i]);
  else if (args[i] === '--wait-200') waitMs = Number(args[++i]);
  else urls.push(args[i]);
}

function once(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.get(u, { timeout: timeoutMs, agent: false, rejectUnauthorized: true }, (res) => {
      let cert;
      if (u.protocol === 'https:') {
        const c = res.socket.getPeerCertificate();
        cert = {
          subject: c.subject?.CN,
          san: c.subjectaltname,
          issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' / '),
          validFrom: c.valid_from,
          validTo: c.valid_to,
          authorized: res.socket.authorized,
        };
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 4000) body += d; });
      res.on('end', () => resolve({ url, ok: true, status: res.statusCode, ms: Date.now() - started, body: body.replace(/\s+/g, ' ').trim().slice(0, 200), cert }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', (e) => resolve({ url, ok: false, error: `${e.code ?? ''} ${e.message}`.trim(), ms: Date.now() - started }));
  });
}

const t0 = Date.now();
let failed = false;
for (const url of urls) {
  let r = await once(url);
  let tries = 1;
  while (waitMs > 0 && r.status !== 200 && Date.now() - t0 < waitMs) {
    await new Promise((s) => setTimeout(s, 1000));
    r = await once(url);
    tries++;
  }
  if (waitMs > 0) Object.assign(r, { tries, msTo200: r.status === 200 ? Date.now() - t0 : null });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  if (r.status !== 200) failed = true;
}
process.exit(failed ? 1 : 0);
