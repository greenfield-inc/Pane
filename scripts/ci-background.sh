#!/usr/bin/env bash
# Runs a CI command in the background across workflow steps.
#   ci-background.sh start <name> <command...>   starts the command and returns
#   ci-background.sh wait <name>                 prints its output and exits with its status
set -euo pipefail

action="$1"
name="$2"
shift 2
dir="${RUNNER_TEMP:?RUNNER_TEMP must be set}/ci-background"
mkdir -p "${dir}"

case "${action}" in
  start)
    rm -f "${dir}/${name}.exit"
    # Detach every stream so the step does not wait on an inherited pipe.
    ( set +e; "$@"; echo $? >"${dir}/${name}.exit" ) </dev/null >"${dir}/${name}.log" 2>&1 &
    echo $! >"${dir}/${name}.pid"
    ;;
  wait)
    while [ ! -f "${dir}/${name}.exit" ]; do
      if ! kill -0 "$(cat "${dir}/${name}.pid")" 2>/dev/null && [ ! -f "${dir}/${name}.exit" ]; then
        cat "${dir}/${name}.log"
        echo "${name} stopped without reporting an exit status" >&2
        exit 1
      fi
      sleep 1
    done
    cat "${dir}/${name}.log"
    exit "$(cat "${dir}/${name}.exit")"
    ;;
  *)
    echo "usage: $0 start|wait <name> [command...]" >&2
    exit 2
    ;;
esac
