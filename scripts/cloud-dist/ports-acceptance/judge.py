#!/usr/bin/env python3
"""Turns the evidence one acceptance step wrote into PASS/FAIL lines (one per assertion).

usage: judge.py <check> <evidence dir> <args...>   (called by acceptance.sh)
Every line: "<time> <check>.<n> PASS|FAIL <assertion> :: <observed>". Exit 1 if any FAIL.
"""
import hashlib
import json
import re
import sys
import time
from pathlib import Path

check, ev = sys.argv[1], Path(sys.argv[2])
args = sys.argv[3:]
results = []


def out(ok, what, seen=''):
    results.append(ok)
    print(f"{time.strftime('%H:%M:%SZ', time.gmtime())} {check}.{len(results)} {'PASS' if ok else 'FAIL'} {what} :: {seen}")


def jl(name):
    p = ev / name
    return [json.loads(line) for line in p.read_text().splitlines() if line.startswith('{')] if p.exists() else []


def js(name):
    try:
        return json.loads((ev / name).read_text())
    except Exception as error:  # a CLI error message instead of JSON
        return {'_error': f'{name}: {error}: {(ev / name).read_text()[:300] if (ev / name).exists() else "missing"}'}


def cert_ok(p, host):
    c = p.get('cert') or {}
    return bool(c.get('authorized')) and host in (c.get('san') or '') and "Let's Encrypt" in (c.get('issuer') or '')


def no_funnel(state):
    """`tailscale funnel status` lists every Serve entry; each must say "tailnet only", none "Funnel on"."""
    if '### tailscale funnel status' not in state:
        return False, 'no state'
    block = state.split('### tailscale funnel status')[1].split('### AllowFunnel')[0]
    entries = [l for l in block.splitlines() if re.match(r'^(https?|tcp)://|^\|-- (tcp|https?)://[a-z]', l) and '(' in l]
    bad = [l for l in block.splitlines() if 'funnel on' in l.lower() or 'available on the internet' in l.lower()]
    ok = not bad and all('tailnet only' in l for l in entries) and 'AllowFunnel in serve config: 0' in state
    return ok, f"{len(entries)} entries all 'tailnet only', AllowFunnel 0" if ok else f'bad={bad[:3]} entries={entries[:5]}'


def by_url(probes):
    return {p['url']: p for p in probes}


if check == 'c1':
    host = args[0]
    lst = js('c1-port-list.json')
    ports = {p['name']: p for p in lst.get('ports', [])}
    dns = lst.get('host', '')
    out(lst.get('available') is True and dns.startswith(host), 'port list answers for the fresh Session (available, host)', f"available={lst.get('available')} host={dns}")
    for name, port, https_port, path in (('demo', 8787, 8787, '/'), ('docs', 3000, 8788, '/index.html')):
        p = ports.get(name, {})
        out(p.get('source') == 'manifest' and p.get('port') == port and p.get('httpsPort') == https_port,
            f'{name}: published from .runpane/ports.json with no action (source manifest, {port}->{https_port})', json.dumps({k: p.get(k) for k in ('source', 'port', 'httpsPort', 'status')}))
        out(p.get('scheme') == 'https' and p.get('url') == f'https://{dns}:{https_port}{path}', f'{name}: https URL on the Session name', p.get('url'))
        out(p.get('reachable') is True and p.get('status') == 'serving', f'{name}: laptop list verifies it (serving, reachable)', f"status={p.get('status')} reachable={p.get('reachable')} detail={p.get('detail', '')}")
    for pr in jl('c1-probe.jsonl'):
        out(pr.get('status') == 200 and f'label={host}' in pr.get('body', ''), f"{pr['url']} answers 200 from agentbox with this Session's body", f"{pr.get('status')} {pr.get('error', '')} {pr.get('body', '')[:90]}")
        out(cert_ok(pr, dns), f"{pr['url']} valid cert (CA-verified, SAN = host, Let's Encrypt)", json.dumps(pr.get('cert')))
    state = (ev / 'c1-session-state.txt').read_text() if (ev / 'c1-session-state.txt').exists() else ''
    m = re.search(r'### ~/.runpane-cloud/ports.json \((\d+)\)', state)
    out(bool(m) and m.group(1) == '600', 'Session ~/.runpane-cloud/ports.json is 0600', m.group(1) if m else 'missing')
    out(*no_funnel(state)[:1], 'no Funnel on the fresh Session', no_funnel(state)[1])
    blocks = re.findall(r'(\S+) ports-block=(\d+)', state)
    out(len(blocks) == 2 and all(n == '1' for _, n in blocks), 'agent notes: one runpane-cloud-ports block in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md', str(blocks))

elif check == 'c2':
    a, b, port = args[0], args[1], int(args[2])
    oa, ob = js('c2-open-a.json'), js('c2-open-b.json')
    ua, ub = oa.get('port', {}).get('url', ''), ob.get('port', {}).get('url', '')
    out(ua.startswith(f'https://{a}.') and f':{port}/' in ua and ub.startswith(f'https://{b}.') and f':{port}/' in ub,
        f'both Sessions publish service port {port} on tailnet port {port} (different names, same port)', f'{ua} | {ub} {oa.get("_error", "")} {ob.get("_error", "")}')
    probes = jl('c2-probe.jsonl')
    pa = [p for p in probes if p['url'] == ua]
    pb = [p for p in probes if p['url'] == ub]
    out(len(pa) == 5 and all(p.get('status') == 200 and f'label={a} ' in p['body'] and f'port={port}' in p['body'] for p in pa), f'{ua}: 5/5 answered by {a}', pa[0].get('body', pa[0].get('error')) if pa else 'no probes')
    out(len(pb) == 5 and all(p.get('status') == 200 and f'label={b} ' in p['body'] and f'port={port}' in p['body'] for p in pb), f'{ub}: 5/5 answered by {b}', pb[0].get('body', pb[0].get('error')) if pb else 'no probes')
    out(bool(pa and pb) and all(cert_ok(p, a) for p in pa) and all(cert_ok(p, b) for p in pb), 'each answered with its own valid cert', f"{(pa[0].get('cert') or {}).get('subject') if pa else ''} | {(pb[0].get('cert') or {}).get('subject') if pb else ''}")
    others = [p for p in probes if p['url'] not in (ua, ub)]
    out(len(others) > 0 and all(p.get('ok') and p.get('status', 599) < 500 for p in others), 'every other published port on both Sessions still answers over https (no interference; a pages host may 404 on /)',
        '; '.join(f"{p['url'].split('//')[1][:60]} {p.get('status', p.get('error'))}" for p in others))
    la = js('c2-port-list-a.json')
    serving_a = [p for p in la.get('ports', []) if p.get('status') == 'serving' and p.get('scheme') == 'https']
    out(len(serving_a) >= 2, f'{a} serves several ports at once over https', ', '.join(f"{p['name']}:{p['httpsPort']}" for p in serving_a))

elif check == 'c3':
    host = args[0]
    wake = (ev / 'c3-wake.txt').read_text() if (ev / 'c3-wake.txt').exists() else ''
    out('is awake' in wake, 'the CLI woke the Session', wake.strip().splitlines()[-2] if wake.strip() else 'no output')
    asleep = jl('c3-while-asleep.jsonl')
    out(len(asleep) > 0 and all(p.get('status') != 200 for p in asleep), 'URLs do not answer while it is asleep (the proof is not a stale cache)', '; '.join(str(p.get('status', p.get('error', '')))[:40] for p in asleep))
    for p in jl('c3-wake-probe.jsonl'):
        out(p.get('status') == 200 and cert_ok(p, host), f"{p['url']} back with no manual action", f"msTo200={p.get('msTo200')} tries={p.get('tries')} body={p.get('body', '')[:80]}")
    before = (ev / 'c3-before-stop.txt').read_text() if (ev / 'c3-before-stop.txt').exists() else ''
    after = (ev / 'c3-after-wake.txt').read_text() if (ev / 'c3-after-wake.txt').exists() else ''
    boot = lambda s: (re.search(r'boot=(\w+)', s) or [None, '?'])[1]
    out(boot(before) != boot(after), 'it really rebooted (boot id changed)', f'{boot(before)} -> {boot(after)}')
    lst = js('c3-port-list-after-wake.json')
    out(all(p.get('status') == 'serving' and p.get('reachable') for p in lst.get('ports', [])) and len(lst.get('ports', [])) >= 2, 'port list after wake: every port serving + reachable',
        ', '.join(f"{p['name']} {p['status']} {p.get('reachable')}" for p in lst.get('ports', [])))

elif check == 'c4':
    host, pp, cp = args[0], int(args[1]), int(args[2])
    before = js('c4-list-before-open.json')
    sug = {s['port']: s for s in before.get('suggested', [])}
    pub = {p['port'] for p in before.get('ports', [])}
    s = sug.get(pp, {})
    out(pp in sug and bool(s.get('panelId')), f'the panel listener :{pp} is suggested (with its panel)', json.dumps(s))
    out(pp not in pub, f':{pp} is not published before `port open`', f'published={sorted(pub)}')
    out(cp not in sug and cp not in pub, f'the control listener :{cp} (not under a panel) is neither suggested nor published', f'suggested={sorted(sug)}')
    pre = jl('c4-probe-before-open.jsonl')
    out(bool(pre) and pre[0].get('status') != 200, f':{pp} unreachable on the tailnet before open', str(pre[0].get('status', pre[0].get('error')) if pre else 'no probe'))
    op = js('c4-open.json').get('port', {})
    post = jl('c4-probe-after-open.jsonl')
    out(op.get('scheme') == 'https' and bool(post) and post[0].get('status') == 200 and cert_ok(post[0], host), '`port open` publishes it: https 200 with a valid cert', f"{op.get('url')} {post[0].get('status') if post else ''}")
    after = js('c4-list-after-open.json')
    out(pp not in {x['port'] for x in after.get('suggested', [])} and pp in {x['port'] for x in after.get('ports', [])}, 'after open it moved from suggested to ports', '')

elif check == 'c5':
    host = args[0]
    text = (ev / 'c5-refusals.txt').read_text()
    blocks = re.split(r'^\$ ', text, flags=re.M)[1:]
    res = {b.splitlines()[0].split(host, 1)[1].strip(): (b, int(re.search(r'exit=(\d+)', b).group(1))) for b in blocks}
    for key, label in (('443', ':443 refused'), ('9443 --https-port 443', ':443 as the tailnet port refused'), ('42137', "the daemon's own port refused"), ('9444 --https-port 42137', "the daemon's port as the tailnet port refused")):
        b, rc = res.get(key, ('missing', 0))
        out(rc != 0 and re.search(r"Pane's own|Pane daemon", b) is not None, label, b.strip().splitlines()[-2][:160] if b != 'missing' else 'missing')
    b, rc = res.get('8787 --https-port 8788 --name pa-dup', ('missing', 0))
    out(rc != 0, 'a second mapping onto a tailnet port another port holds is refused', b.strip().splitlines()[-2][:160])
    for key, label in (('8080 --https-port 80 --name pa-priv80', 'privileged tailnet port 80'), ('22 --name pa-sshd', 'a foreign local service (sshd :22)')):
        b, rc = res.get(key, ('missing', 0))
        # Informational: the design only reserves 443 and the daemon's port; recorded as observed.
        print(f"{time.strftime('%H:%M:%SZ', time.gmtime())} {check}.info {label}: exit={rc} :: {b.strip().splitlines()[-1][:200] if b != 'missing' else ''}")
    st = lambda name: (ev / name).read_text() if (ev / name).exists() else ''
    # The rp_tailnet table without packet counters (the drop rule counts packets, so a raw hash always moves).
    def sha(s):
        if '### nft rp tables' not in s:
            return '?'
        table = re.sub(r'counter packets \d+ bytes \d+', 'counter', s.split('### nft rp tables')[1].split('### ~')[0])
        return hashlib.sha256(table.encode()).hexdigest()[:16] if 'rp_tailnet' in table else '?'
    s0, s1, s2 = st('c5-state-before.txt'), st('c5-state-after-tries.txt'), st('c5-state-after-close.txt')
    out(sha(s0) == sha(s1) == sha(s2) and sha(s0) != '?', 'the Session firewall (nft rp_tailnet table, counters aside) is unchanged by open/close', f'{sha(s0)} {sha(s1)} {sha(s2)}')
    serve = lambda s: s.split('### tailscale serve status --json')[1].split('### tailscale funnel status')[0].strip() if '### tailscale serve status --json' in s else '?'
    try:
        w0, w2 = json.loads(serve(s0)).get('TCP', {}), json.loads(serve(s2)).get('TCP', {})
        out(set(w2) <= set(w0), 'after closing, Serve holds no port that was not there before the tries', f'before={sorted(w0)} after={sorted(w2)}')
    except Exception as error:
        out(False, 'serve status parses', str(error))
    for name, s in (('before', s0), ('after tries', s1), ('after close', s2)):
        ok, seen = no_funnel(s)
        out(ok, f'no Funnel anywhere in Serve ({name})', seen)

elif check == 'c6':
    host = args[0]
    for engine in ('chromium', 'webkit'):
        t = (ev / f'c6-walk-{engine}.txt').read_text() if (ev / f'c6-walk-{engine}.txt').exists() else ''
        lines = t.splitlines()
        n_pass, n_fail = sum(l.startswith('PASS ') for l in lines), sum(l.startswith('FAIL ') for l in lines)
        out(n_pass == 13 and n_fail == 0, f'{engine} taste walk 13/13 on https://{host}...:8443', f'{n_pass} pass, {n_fail} fail')
    lst = js('c6-scratch-port-list.json')
    ports = {p['httpsPort']: p for p in lst.get('ports', [])}
    for hp, name in ((8443, 'taste'), (8444, 'taste-pages')):
        p = ports.get(hp, {})
        out(p.get('name') == name and p.get('status') == 'serving' and p.get('scheme') == 'https' and p.get('url', '').startswith(f'https://{host}.'), f'Scratch :{hp} is a managed port named {name} (serving, https)',
            json.dumps({k: p.get(k) for k in ('name', 'source', 'status', 'url', 'reachable')}) if p else lst.get('_error', 'absent'))

else:
    sys.exit(f'unknown check {check}')

sys.exit(0 if all(results) else 1)
