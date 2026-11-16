#!/usr/bin/env bash
# Fails unless every gate ended exactly as expected. RESULTS holds one
# `name|actual|expected` line per gate; `expected` is a job result, or `bool`
# for a filter output that must be true or false. An empty or missing value
# fails, so a gate that never reported cannot pass.
set -euo pipefail

fail=0
while IFS='|' read -r name actual expected; do
  [ -z "$name" ] && continue
  if [ "$expected" = bool ]; then
    case "$actual" in
      true | false) ;;
      *) echo "::error::$name is '$actual', expected true or false"; fail=1 ;;
    esac
  elif [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "::error::$name ended '$actual', expected '$expected'"
    fail=1
  fi
done <<< "${RESULTS:?RESULTS is empty}"

[ "$fail" = 0 ] && echo "Every gate ended as expected."
exit "$fail"
