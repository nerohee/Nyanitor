#!/bin/bash
# Fake install script for the P4-02 tests (not the real one). It never touches ~/.claude.
# Next to it the test puts: <op>.out (stdout bytes), <op>.exit (exit code), <op>.sleep (seconds).
# <op> is one of: plan, install, backups, restore-plan, restore.
here="$(cd "$(dirname "$0")" && pwd)"
line="$*"
case "$line" in
  *--backups*) op=backups ;;
  *--restore*--plan*) op=restore-plan ;;
  *--restore*) op=restore ;;
  *--plan*) op=plan ;;
  *) op=install ;;
esac
printf '%s|%s|CFG=%s|HOME=%s\n' "$op" "$line" "$CLAUDE_CONFIG_DIR" "$CLAUDE_HARNESS_HOME" >> "$here/calls.log"
[ -f "$here/$op.sleep" ] && sleep "$(head -n 1 "$here/$op.sleep")"
[ -f "$here/$op.out" ] && cat "$here/$op.out"
[ -f "$here/$op.exit" ] && exit "$(head -n 1 "$here/$op.exit")"
exit 0
