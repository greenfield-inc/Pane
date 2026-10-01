#!/usr/bin/env bash
# Self-test of fakegithub.py on this machine (no network, no boat): proves the fake enforces what GitHub
# enforces, so the broker gate can trust a refusal to be the broker's. Real git, a real RS256 JWT (openssl).
# Usage: tests/cloud-e2e/lib/fakegithub-selftest.sh [workdir]
set -uo pipefail
LIB="$(cd "$(dirname "$0")" && pwd)"
W="${1:-$(mktemp -d)}"; mkdir -p "$W"; ST="$W/state"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
expect() { local want="$1" got="$2"; shift 2; [ "$got" = "$want" ] && ok "$* ($got)" || bad "$* (want $want, got $got)"; }

openssl genrsa -out "$W/app.pem" 2048 2>/dev/null; openssl rsa -in "$W/app.pem" -pubout -out "$W/app.pub" 2>/dev/null
openssl genrsa -out "$W/other.pem" 2048 2>/dev/null
python3 "$LIB/fakegithub.py" init --state "$ST" --repo acme/app --app-id 777 --app-public-key "$W/app.pub" --installation-id 4242 >/dev/null
python3 "$LIB/fakegithub.py" serve --state "$ST" --port 0 --port-file "$W/port" >"$W/serve.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 50); do [ -s "$W/port" ] && break; sleep 0.1; done
B="http://127.0.0.1:$(cat "$W/port")"

jwt() {  # jwt <pem> [iss] [ttl]
  local h p s now; now=$(date +%s)
  h=$(printf '{"alg":"RS256","typ":"JWT"}' | basenc --base64url | tr -d '=\n')
  p=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' $((now-30)) $((now+${3:-540})) "${2:-777}" | basenc --base64url | tr -d '=\n')
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$1" | basenc --base64url | tr -d '=\n')
  printf '%s.%s.%s' "$h" "$p" "$s"
}
code() { curl -s -o "$W/last.json" -w '%{http_code}' "$@"; }
J=$(jwt "$W/app.pem")
expect 200 "$(code -H "Authorization: Bearer $J" "$B/app")" "app JWT accepted"
expect 401 "$(code -H "Authorization: Bearer $(jwt "$W/other.pem")" "$B/app")" "JWT signed by another key refused"
expect 401 "$(code -H "Authorization: Bearer $(jwt "$W/app.pem" 999)" "$B/app")" "JWT with the wrong iss refused"
expect 401 "$(code -H "Authorization: Bearer $(jwt "$W/app.pem" 777 3600)" "$B/app")" "JWT with exp > 10 min refused"
expect 200 "$(code -H "Authorization: Bearer $J" "$B/repos/acme/app/installation")" "installation lookup"
mint() { curl -s -X POST -H "Authorization: Bearer $J" -d "$1" "$B/app/installations/4242/access_tokens" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))'; }
expect 422 "$(code -X POST -H "Authorization: Bearer $J" -d '{"permissions":{"workflows":"write"}}' "$B/app/installations/4242/access_tokens")" "minting beyond the grant (workflows) refused"
RT=$(mint '{"repositories":["app"],"permissions":{"contents":"read","metadata":"read"}}')
WT=$(mint '{"repositories":["app"],"permissions":{"contents":"write","metadata":"read"}}')
PT=$(mint '{"repositories":["app"],"permissions":{"pull_requests":"write","issues":"write","contents":"read","metadata":"read"}}')
NT=$(mint '{"repositories":["app"],"permissions":{"pull_requests":"write","issues":"write","metadata":"read"}}')
[ -n "$RT" ] && [ -n "$WT" ] && [ -n "$PT" ] && ok "3 downscoped installation tokens minted" || bad "token mint failed"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
url() { printf '%s' "${B/http:\/\//http://x-access-token:$1@}/acme/app.git"; }
git clone -q "$(url "$RT")" "$W/c" 2>"$W/clone.err" && ok "clone with a contents:read token" || bad "clone: $(cat "$W/clone.err")"
git clone -q "$B/acme/app.git" "$W/anon" 2>/dev/null && bad "anonymous clone of a private repo worked" || ok "anonymous clone refused"
cd "$W/c" && git -c user.name=t -c user.email=t@x commit -q --allow-empty -m probe && git branch -q cloud/h/x
MASTER0=$(git rev-parse origin/master)
git push -q "$(url "$RT")" cloud/h/x 2>/dev/null && bad "push with a read token worked" || ok "push with a contents:read token refused"
git push -q "$(url "$WT")" cloud/h/x 2>/dev/null && ok "push of a new branch with contents:write" || bad "push with write token failed"
echo "x: 1" >> .github/workflows/ci.yml && git -c user.name=t -c user.email=t@x commit -qam wf && git branch -q cloud/h/wf
git push "$(url "$WT")" cloud/h/wf 2>"$W/wf.err" && bad "workflow push without workflows permission accepted" || \
  { grep -q "without \`workflows\` permission" "$W/wf.err" && ok "workflow-file push refused by GitHub's rule" || bad "workflow push refused for another reason: $(cat "$W/wf.err")"; }
git checkout -q -b tmp "$MASTER0" && git -c user.name=t -c user.email=t@x commit -q --allow-empty -m m
git push -q "$(url "$WT")" HEAD:master 2>/dev/null && ok "no branch protection: a write token CAN move master (like montlakev2 on the free plan)" || bad "fake protects master"

expect 422 "$(code -H "Authorization: token $NT" -X POST -d '{"title":"t","head":"cloud/h/x","base":"master","draft":true}' "$B/repos/acme/app/pulls")" "PR without contents:read refused (GitHub: not all refs are readable)"
grep -q "not all refs are readable" "$W/last.json" && ok "422 carries GitHub's message" || bad "422 body: $(cat "$W/last.json")"
A=(-H "Authorization: token $PT")
expect 201 "$(code "${A[@]}" -X POST -d '{"title":"t","head":"cloud/h/x","base":"master","draft":true,"body":"b"}' "$B/repos/acme/app/pulls")" "draft PR created"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d["draft"] and d["user"]["login"].endswith("[bot]") else 1)' "$W/last.json" && ok "PR is draft, author is the app bot" || bad "PR fields"
expect 422 "$(code "${A[@]}" -X POST -d '{"title":"t","head":"cloud/h/nope","base":"master"}' "$B/repos/acme/app/pulls")" "PR from a missing branch refused"
expect 201 "$(code "${A[@]}" -X POST -d '{"title":"i","body":"b","labels":["bug","nope"]}' "$B/repos/acme/app/issues")" "issue created"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if [l["name"] for l in d["labels"]]==["bug","nope"] else 1)' "$W/last.json" && ok "unknown label auto-created, as GitHub does" || bad "labels"
expect 201 "$(code "${A[@]}" -X POST -d '{"body":"c"}' "$B/repos/acme/app/issues/2/comments")" "comment"
expect 200 "$(code "${A[@]}" -X PATCH -d '{"state":"closed"}' "$B/repos/acme/app/issues/2")" "issue closed"
expect 403 "$(code -H "Authorization: token $RT" -X POST -d '{"title":"x"}' "$B/repos/acme/app/issues")" "issue create with a contents-only token refused"
expect 403 "$(code "${A[@]}" "$B/repos/acme/app/commits/master/check-runs")" "check-runs need the Checks permission"
expect 422 "$(code -X POST -H "Authorization: Bearer $J" -d '{"permissions":{"checks":"read"}}' "$B/app/installations/4242/access_tokens")" "checks:read not in this installation's grant"
expect 403 "$(code "${A[@]}" "$B/repos/acme/app/commits/master/status")" "combined status needs the Commit statuses permission"
expect 403 "$(code "${A[@]}" "$B/repos/acme/app/actions/runs")" "Actions runs need the Actions permission"
expect 404 "$(code "${A[@]}" "$B/repos/acme/other/issues")" "a repo outside the token is invisible"
expect 200 "$(code "${A[@]}" -X PUT "$B/repos/acme/app/pulls/1/merge")" "merge endpoint modelled (and logged)"
ADM=(-H "X-Fake-Admin: $(cat "$ST/admin-token")")
expect 201 "$(code "${ADM[@]}" -X POST -d '{"repo":"acme/app","head":"cloud/other/y","title":"theirs"}' "$B/_fake/seed/pull")" "admin seed of another Session's PR"
HS=$(git -C "$W/c" rev-parse cloud/h/x)
expect 201 "$(code "${ADM[@]}" -X POST -d "{\"repo\":\"acme/app\",\"sha\":\"$HS\",\"name\":\"ci\"}" "$B/_fake/seed/check")" "admin seed of a check run"
python3 "$LIB/fakegithub.py" init --state "$ST" --repo acme/app --app-id 777 --app-public-key "$W/app.pub" --installation-id 4242 --grant checks=read >/dev/null
KT=$(mint '{"repositories":["app"],"permissions":{"checks":"read"}}')
expect 200 "$(code -H "Authorization: token $KT" "$B/repos/acme/app/commits/$HS/check-runs")" "check-runs with a checks:read token (grant added)"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d["total_count"]==1 and d["check_runs"][0]["conclusion"]=="success" else 1)' "$W/last.json" && ok "seeded check run returned" || bad "check-runs body"
expect 403 "$(code "$B/_fake/log")" "admin endpoints need the admin token"
curl -s "${ADM[@]}" "$B/_fake/log" > "$W/log.jsonl"
n_merge=$(python3 -c 'import json,sys;print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("merge")))' "$W/log.jsonl")
expect 1 "$n_merge" "request log flags merge calls"
leaks=0; for t in "$RT" "$WT" "$PT" "$J"; do grep -qF "$t" "$W/log.jsonl" "$ST/receive.jsonl" && leaks=$((leaks+1)); done
expect 0 "$leaks" "no token or JWT appears in the fake's logs"
python3 -c 'import json,sys;r=[json.loads(l) for l in open(sys.argv[1])];print(sum(1 for x in r if x.get("receive")))' "$W/log.jsonl" | { read -r n; [ "$n" -ge 3 ] && ok "receive-pack ref updates are logged ($n pushes)" || bad "receive log ($n)"; }
echo "selftest: $fails failure(s); workdir $W"
exit $((fails > 0))
