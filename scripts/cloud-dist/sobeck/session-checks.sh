#!/usr/bin/env bash
# R3.5: the checks that run INSIDE a fresh Pane on a cloud Session. session-proof.mjs types this file into
# the Pane's terminal (base64, never a value of anything) and reads back one line per check:
#   R35 <tag> <check> <PASS|FAIL|SKIP|INFO> <detail>          (for people)
#   R35:<tag>:<base64 of check TAB verdict TAB detail>:/R35   (for the reader: no spaces, so it survives a
#                                                             terminal that wraps and pads lines, e.g. ConPTY)
# Phases (the desktop checks the Ports chip between "setup" and "broker"):
#   setup <tag> <port>          context, manifest secrets (names only), a tiny server + runpane port open
#   broker <tag> <port> <github> GitHub broker: push, gh issue create, gh pr create --draft, master refused,
#                               both closed again; github=0 skips it (no coordinator, e.g. CI)
#   cleanup <tag> <port>        runpane port close, stop the server
# Secrets: only names and counts are printed. A value is only ever tested for being non-empty, inside
# `doppler run`, and never leaves that child process.
set -u
phase=${1:?phase}; tag=${2:?tag}; port=${3:?port}; github=${4:-1}
name="r35-$tag"
work="${TMPDIR:-/tmp}/runpane-r35-$tag"
mkdir -p "$work"
say() {
  printf 'R35 %s %s %s %s\n' "$tag" "$1" "$2" "$3"
  printf 'R35:%s:%s:/R35\n' "$tag" "$(printf '%s\t%s\t%s' "$1" "$2" "$3" | base64 | tr -d '\n')"
}
oneline() { tr '\r\n\t' '   ' | sed 's/  */ /g' | cut -c1-"${1:-300}"; }
# The runpane of the daemon that owns this terminal: Pane exports it as PANE_RUNPANE_BIN (on Windows a
# runpane.cmd, which `test -x` doesn't recognize from Git Bash, so it isn't tested). Never another install's.
runpane_cli() {
  if [ -n "${PANE_RUNPANE_BIN:-}" ]; then "$PANE_RUNPANE_BIN" "$@"; return; fi
  local candidate
  for candidate in "$HOME/.pane_remote/bin/runpane" "$HOME/.pane/bin/runpane"; do
    if [ -x "$candidate" ]; then "$candidate" "$@"; return; fi
  done
  runpane "$@"
}
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v===undefined||v===null?"":String(v))}catch{}})' "$1"; }

setup() {
  say context INFO "host $(hostname); dir $PWD; branch $(git branch --show-current 2>/dev/null); head $(git rev-parse --short HEAD 2>/dev/null)"

  # 1. Manifest secrets, present in the new Pane without any step of ours (names only).
  if ! command -v doppler >/dev/null 2>&1; then
    say secrets-at-creation SKIP "no doppler stand-in in this Session (runpane cloud secrets enable <host>)"
  else
    doppler secrets --only-names >"$work/names" 2>"$work/names.err"
    local count first status_line probe
    count=$(grep -c . "$work/names")
    first=$(head -n 1 "$work/names")
    status_line=$(doppler status 2>&1 | head -n 1 | oneline 220)
    probe=unset
    if [ -n "$first" ] && doppler run -- sh -c 'test -n "$(printenv "$1")"' r35 "$first" >/dev/null 2>&1; then probe=set; fi
    if [ "$count" -gt 0 ] && [ "$probe" = set ]; then
      say secrets-at-creation PASS "$count names (e.g. $(head -n 5 "$work/names" | paste -sd, -)); $first is set in doppler run (value not shown); $status_line"
    else
      say secrets-at-creation FAIL "$count names; $first in doppler run: $probe; $status_line; $(oneline 160 <"$work/names.err")"
    fi
  fi

  # 2. A tiny server in this Pane, published as a Session port.
  mkdir -p "$work/site"
  printf 'runpane-cloud R3.5 %s\n' "$tag" >"$work/site/index.html"
  # node, not python: it is on PATH in every Pane terminal (Windows' python3 can be a Store stub).
  local detach=
  command -v setsid >/dev/null 2>&1 && detach=setsid
  (cd "$work/site" && $detach nohup node -e 'const fs=require("fs");require("http").createServer((q,r)=>(r.setHeader("content-type","text/plain; charset=utf-8"),r.end(fs.readFileSync("index.html")))).listen(Number(process.argv[1]),"127.0.0.1")' "$port" </dev/null >"$work/server.log" 2>&1 & echo $! >"$work/server.pid")
  local i code
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)
    [ "$code" = 200 ] && break
    sleep 0.5
  done
  if [ "$code" != 200 ]; then say port-open FAIL "server on 127.0.0.1:$port never answered ($code)"; return; fi
  runpane_cli port open "$port" --name "$name" --yes --json >"$work/open.json" 2>"$work/open.err"
  local url
  url=$(json_field port.url <"$work/open.json")
  if [ -n "$url" ]; then
    say port-open PASS "runpane port open $port --name $name -> $url"
  else
    say port-open FAIL "runpane port open $port: $(oneline 240 <"$work/open.err") $(oneline 200 <"$work/open.json")"
  fi
}

broker() {
  if [ "$github" != 1 ]; then
    say broker SKIP "github=0 (no runpane cloud coordinator here)"
    return
  fi
  local branch repo title body pushed ref issue pr state draft head
  branch=$(git branch --show-current)
  repo=$(git remote get-url origin | sed -E 's#^.*github\.com[^:/]*[:/]##; s#\.git$##')
  title="[runpane-cloud TEST] R3.5 $tag"
  body="Automated R3.5 check from a fresh Pane on runpane cloud Session $(hostname) ($tag). Closed by the same check."

  git -c user.name='runpane cloud R3.5' -c user.email='r35@runpane.invalid' commit -q --allow-empty -m "$title"
  pushed=$(runpane_cli cloud agent github push --json 2>"$work/push.err")
  ref=$(printf '%s' "$pushed" | json_field ref)
  case "$ref" in
    cloud/*/"$branch") say broker-push PASS "$branch -> $ref ($(printf '%s' "$pushed" | json_field outcome), $(git rev-parse --short HEAD))" ;;
    *) say broker-push FAIL "$branch -> '$ref': $(oneline 240 <"$work/push.err")"; return ;;
  esac

  issue=$(gh issue create --title "$title (issue)" --body "$body" 2>"$work/issue.err" | tail -n 1)
  case "$issue" in
    https://github.com/*/issues/*) say gh-issue-create PASS "$issue" ;;
    *) say gh-issue-create FAIL "$(oneline 240 <"$work/issue.err")" ;;
  esac

  pr=$(gh pr create --draft --title "$title (PR)" --body "$body" 2>"$work/pr.err" | tail -n 1)
  case "$pr" in
    https://github.com/*/pull/*)
      gh pr view "${pr##*/}" --json isDraft,headRefName,state >"$work/pr.json" 2>/dev/null
      draft=$(json_field isDraft <"$work/pr.json"); head=$(json_field headRefName <"$work/pr.json")
      if [ "$draft" = true ] && [ "$head" = "$ref" ]; then say gh-pr-create-draft PASS "$pr (draft, head $head)"
      else say gh-pr-create-draft FAIL "$pr: isDraft=$draft head=$head (expected $ref)"; fi ;;
    *) say gh-pr-create-draft FAIL "$(oneline 240 <"$work/pr.err")" ;;
  esac

  # master: a throwaway clone of this worktree whose local master carries the test commit, so the push
  # gets past the local "nothing new" check and the coordinator itself must refuse it.
  local clone before after refused
  before=$(git ls-remote origin refs/heads/master 2>/dev/null | cut -c1-12)
  clone="$work/master-clone"
  rm -rf "$clone"
  git clone -q --shared --no-checkout "$PWD" "$clone" \
    && git -C "$clone" update-ref refs/remotes/origin/master "$(git rev-parse origin/master)" \
    && git -C "$clone" remote set-head origin master \
    && git -C "$clone" update-ref refs/heads/master "$(git rev-parse HEAD)"
  runpane_cli cloud agent github push --path "$clone" --branch master --repo "$repo" >"$work/master.out" 2>&1
  refused=$?
  rm -rf "$clone"
  after=$(git ls-remote origin refs/heads/master 2>/dev/null | cut -c1-12)
  # The CLI prints the coordinator's message, not its code: "master is the default branch; push a feature
  # branch (it lands as cloud/<host>/<branch>)" is the coordinator's ref-outside-namespace refusal
  # (coordinator/github/broker.ts), raised after it received the bundle.
  local why
  why=$(grep -m1 -o -E 'ref-outside-namespace.*|master is (the default branch|reserved); push a feature branch.*' "$work/master.out" | oneline 200)
  if [ "$refused" -ne 0 ] && [ -n "$why" ] && [ -n "$before" ] && [ "$before" = "$after" ]; then
    say master-push-refused PASS "push --branch master exit $refused, refused by the coordinator (ref-outside-namespace): $why; master still $after"
  else
    say master-push-refused FAIL "exit $refused: $(oneline 240 <"$work/master.out"); master $before -> $after"
  fi

  case "$issue" in
    https://github.com/*/issues/*)
      gh issue close "${issue##*/}" >/dev/null 2>"$work/issue-close.err"
      state=$(gh issue view "${issue##*/}" --json state 2>/dev/null | json_field state)
      if [ "$state" = CLOSED ]; then say gh-issue-close PASS "$issue CLOSED"; else say gh-issue-close FAIL "$issue state=$state $(oneline 200 <"$work/issue-close.err")"; fi ;;
    *) say gh-issue-close SKIP "no issue" ;;
  esac
  case "$pr" in
    https://github.com/*/pull/*)
      gh pr close "${pr##*/}" >/dev/null 2>"$work/pr-close.err"
      state=$(gh pr view "${pr##*/}" --json state 2>/dev/null | json_field state)
      if [ "$state" = CLOSED ]; then say gh-pr-close PASS "$pr CLOSED (branch $ref kept)"; else say gh-pr-close FAIL "$pr state=$state $(oneline 200 <"$work/pr-close.err")"; fi ;;
    *) say gh-pr-close SKIP "no pull request" ;;
  esac
}

cleanup() {
  runpane_cli port close "$name" >/dev/null 2>"$work/close.err"
  [ -f "$work/server.pid" ] && kill "$(cat "$work/server.pid")" 2>/dev/null
  local listed
  if ! listed=$(runpane_cli port list --json 2>&1); then
    say port-closed FAIL "runpane port list failed: $(printf '%s' "$listed" | oneline 200)"
  elif printf '%s' "$listed" | grep -q "\"$name\""; then
    say port-closed FAIL "$name still listed: $(oneline 200 <"$work/close.err")"
  else
    say port-closed PASS "$name closed, server stopped"
  fi
  rm -rf "$work" "$0"
}

case "$phase" in
  setup) setup ;;
  broker) broker ;;
  cleanup) cleanup ;;
  *) say phase FAIL "unknown phase $phase" ;;
esac
say phase-done INFO "$phase"
