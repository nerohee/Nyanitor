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
[ -f "$here/$op.out" ] && cat "$here/$op.out"
[ -f "$here/$op.exit" ] && exit "$(head -n 1 "$here/$op.exit")"
exit 0
