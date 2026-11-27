#!/system/bin/sh
DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd) || exit 1
[ "$DIR" = /data/adb/modules/cpupow ] || exit 2
child=
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; exit 0' INT TERM
while true; do
    sleep 30 &
    child=$!
    wait "$child"
    child=
    [ ! -e "$DIR/disable" ] && [ ! -e "$DIR/remove" ] || exit 0
    if ! sh "$DIR/bin/lifecycle.sh" ensure >> "$DIR/watchdog.log" 2>&1; then
        echo "[$(date '+%H:%M:%S')] daemon recovery failed" >> "$DIR/watchdog.log"
    fi
    size=$(stat -c %s "$DIR/watchdog.log" 2>/dev/null || echo 0)
    if [ "$size" -gt 262144 ]; then
        tail -n 200 "$DIR/watchdog.log" > "$DIR/watchdog.log.tmp" && mv -f "$DIR/watchdog.log.tmp" "$DIR/watchdog.log"
    fi
done