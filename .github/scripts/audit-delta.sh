#!/usr/bin/env bash
# Compares two `yarn npm audit --all --recursive --no-deprecations --json` runs by their high and
# critical (GHSA id, package) pairs.
#   audit-delta.sh classify <ndjson> <exit-code>   prints report, clean or unavailable
#   audit-delta.sh compare <base.ndjson> <base-exit> <head.ndjson> <head-exit>
# compare writes the step summary and exits 1 only when the head has a pair the base lacks. If either
# run is unavailable it warns and exits 0; the weekly scheduled run on main is the backstop.
set -euo pipefail

classify() {
  local file=$1 code=$2
  if ! grep -q '[^[:space:]]' "$file"; then
    if [ "$code" = 0 ]; then echo clean; else echo unavailable; fi
  # Yarn exits 1 when it finds advisories. A line without an advisory URL is error text or a
  # deprecation record, and either makes the run incomparable.
  elif { [ "$code" = 0 ] || [ "$code" = 1 ]; } && jq -es 'all(.[];
      (.value | type) == "string" and (.children.URL | type) == "string"
      and (.children.Severity | type) == "string" and (.children.Issue | type) == "string")' \
      "$file" > /dev/null 2>&1; then
    echo report
  else
    echo unavailable
  fi
}

# One "GHSA id, package, severity, title" line (tab-separated) per high or critical pair.
pairs() {
  jq -r 'select(.children.Severity == "high" or .children.Severity == "critical")
    | [((.children.URL | capture("(?<id>GHSA(-[0-9a-z]{4}){3})") | .id) // .children.URL),
       .value, .children.Severity, .children.Issue]
    | @tsv' "$1" | sort -t $'\t' -k1,2 -u
}

lines() { if [ -n "$1" ]; then printf '%s\n' "$1"; fi; }

compare() {
  local base_file=$1 base_exit=$2 head_file=$3 head_exit=$4 summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
  local base head base_pairs='' head_pairs='' new
  base=$(classify "$base_file" "$base_exit")
  head=$(classify "$head_file" "$head_exit")
  # A failed extraction must not read as an empty list.
  if [ "$base" != unavailable ] && ! base_pairs=$(pairs "$base_file"); then base=unavailable; fi
  if [ "$head" != unavailable ] && ! head_pairs=$(pairs "$head_file"); then head=unavailable; fi
  if [ "$base" = unavailable ] || [ "$head" = unavailable ]; then
    echo "::warning title=Dependency audit delta::not compared (base $base, exit $base_exit; head $head, exit $head_exit); passing"
    for f in "$base_file" "$head_file"; do head -n 5 "$f"; done
    printf '## Dependency audit delta\n\nNot compared: base %s (exit %s), head %s (exit %s). Passing; the weekly run on main is the backstop.\n' \
      "$base" "$base_exit" "$head" "$head_exit" >> "$summary"
    return 0
  fi
  # FILENAME, not NR == FNR: the base list is empty when the base is clean.
  new=$(awk -F '\t' 'FILENAME == ARGV[1] { seen[$1 FS $2] = 1; next } !seen[$1 FS $2]' \
    <(lines "$base_pairs") <(lines "$head_pairs"))
  {
    echo "## Dependency audit delta"
    echo
    echo "High and critical (advisory, package) pairs: base $(lines "$base_pairs" | wc -l), head $(lines "$head_pairs" | wc -l)."
    if [ -n "$new" ]; then
      echo
      echo "| Severity | Package | Advisory | Issue |"
      echo "|---|---|---|---|"
      awk -F '\t' '{ gsub(/\|/, "\\|", $4); print "| " $3 " | `" $2 "` | " $1 " | " $4 " |" }' <<< "$new"
    else
      echo "None is new."
    fi
  } >> "$summary"
  [ -z "$new" ] && return 0
  # Workflow commands decode %XX in a message, so a literal % goes out as %25.
  awk -F '\t' '{ gsub(/%/, "%25"); print "::error title=New " $3 " advisory::" $2 " " $1 ": " $4 }' <<< "$new"
  return 1
}

case "${1:-}" in
  classify) classify "$2" "$3" ;;
  compare) compare "$2" "$3" "$4" "$5" ;;
  *) echo "usage: $0 classify <ndjson> <exit> | compare <base.ndjson> <base-exit> <head.ndjson> <head-exit>" >&2; exit 2 ;;
esac
