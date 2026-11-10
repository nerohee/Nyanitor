#!/bin/bash
# Fake install script for the P9-01 tests (not the real one). It never touches ~/.claude.
# Like tests/fixtures/harness/install.sh, and it also records which files it saw under <harness home>/custom/agents and /skills.
# calls.log line: "<op>|<sorted relative file list>". Next to it the test puts: <op>.out (stdout bytes), <op>.exit (exit code).
here="$(cd "$(dirname "$0")" && pwd)"
line="$*"
case "$line" in
  *--backups*) op=backups ;;
  *--restore*--plan*) op=restore-plan ;;
  *--restore*) op=restore ;;
  *--plan*) op=plan ;;
  *) op=install ;;
esac
custom="$CLAUDE_HARNESS_HOME/custom"
seen=""
if [ -d "$custom" ]; then
  seen="$(cd "$custom" && find agents skills -type f 2>/dev/null | LC_ALL=C sort | paste -sd, -)"
fi
printf '%s|%s\n' "$op" "$seen" >> "$here/calls.log"
# --- P9-06 extra modes (off unless the test drops the marker file next to this script) ---
# <op>.sleep: seconds to wait before answering. strict: orphan values/append in custom/agents -> exit 3.
# mirror: a successful install rebuilds $CLAUDE_CONFIG_DIR/agents (source agents overlaid by custom agents, no *.append.md).
[ -f "$here/$op.sleep" ] && sleep "$(head -n 1 "$here/$op.sleep")"
forced=""
if [ "$op" = install ] && [ -f "$here/strict" ] && [ -d "$custom/agents" ]; then
  for f in "$custom"/agents/*.values.yml "$custom"/agents/*.append.md; do
    [ -f "$f" ] || continue
    n="$(basename "$f")"; n="${n%.values.yml}"; n="${n%.append.md}"
    [ -f "$custom/agents/$n.md" ] || [ -f "$here/agents/$n.md" ] || forced=3
  done
fi
if [ "$op" = install ] && [ -z "$forced" ] && [ -f "$here/mirror" ]; then
  rm -rf "$CLAUDE_CONFIG_DIR/agents"; mkdir -p "$CLAUDE_CONFIG_DIR/agents"
  for f in "$here"/agents/*.md "$custom"/agents/*.md; do
    [ -f "$f" ] || continue
    case "$f" in *.append.md) continue ;; esac
    cp "$f" "$CLAUDE_CONFIG_DIR/agents/"
  done
fi
[ -f "$here/$op.out" ] && cat "$here/$op.out"
[ -n "$forced" ] && exit "$forced"
[ -f "$here/$op.exit" ] && exit "$(head -n 1 "$here/$op.exit")"
exit 0
