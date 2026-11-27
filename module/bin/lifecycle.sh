#!/system/bin/sh
# 说明：单实例生命周期；必须联合核验开机标识、启动时刻和可执行文件，不能只相信进程记录。
DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd) || exit 1
[ "$DIR" = /data/adb/modules/cpupow ] || exit 2
BIN="$DIR/cpupow"
LOCK="$DIR/.lifecycle.lock"
WD_PID="$DIR/.watchdog.pid"
log() { echo "[$(date '+%H:%M:%S')] $*"; }
owned() {
    [ -r "$DIR/.daemon.pid" ] || return 1
    read -r pid start boot < "$DIR/.daemon.pid"
    case "$pid:$start" in *[!0-9:]*|:*|*:) return 1;; esac
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 1
    [ "$(readlink "/proc/$pid/exe")" = "$BIN" ] || return 1
    line=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
    rest=${line##*) }
    actual=$(printf '%s\n' "$rest" | awk '{print $20}')
    [ "$actual" = "$start" ] || return 1
    kill -0 "$pid" 2>/dev/null
}
watchdog_alive() {
    [ -r "$WD_PID" ] || return 1
    wp=$(cat "$WD_PID")
    case "$wp" in ''|*[!0-9]*) return 1;; esac
    [ -r "/proc/$wp/cmdline" ] || return 1
    tr '\000' ' ' < "/proc/$wp/cmdline" | grep -F "$DIR/bin/watchdog.sh" >/dev/null
}
lock() {
    n=0
    until mkdir "$LOCK" 2>/dev/null; do
        p=$(cat "$LOCK/pid" 2>/dev/null)
        case "$p" in ''|*[!0-9]*) p=0;; esac
        if [ "$p" -gt 0 ] && ! kill -0 "$p" 2>/dev/null; then
            rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null
        fi
        n=$((n+1)); [ "$n" -lt 15 ] || return 1
        sleep 1
    done
    echo $$ > "$LOCK/pid"
    trap 'rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null' EXIT
    trap 'exit 1' INT TERM
}
start_daemon() {
    owned && return 0
    [ -x "$BIN" ] && [ -s "$DIR/cpu_policy.json" ] || return 1
    (cd "$DIR" && setsid nohup "$BIN" </dev/null >/dev/null 2>&1) &
    sleep 2
    owned || { log '守护进程启动未确认'; return 1; }
    log "守护进程已运行: $pid"
}
stop_daemon() {
    if owned; then
        kill -TERM "$pid" || return 1
        n=0
        while owned && [ "$n" -lt 12 ]; do sleep 1; n=$((n+1)); done
        if owned; then kill -KILL "$pid" || return 1; sleep 1; fi
        owned && return 1
    fi
    return 0
}
stop_watchdog() {
    if watchdog_alive; then
        kill -TERM "$wp" || return 1
        n=0
        while watchdog_alive && [ "$n" -lt 5 ]; do sleep 1; n=$((n+1)); done
        watchdog_alive && return 1
    fi
    rm -f "$WD_PID"
}
start_watchdog() {
    watchdog_alive && return 0
    setsid nohup sh "$DIR/bin/watchdog.sh" </dev/null >/dev/null 2>&1 &
    echo $! > "$WD_PID"
    sleep 1
    watchdog_alive
}
case "$1" in
    status)
        if owned; then echo "daemon_pids=$pid"; else echo 'daemon_pids='; fi
        if watchdog_alive; then echo 'watchdog=running'; else echo 'watchdog=stopped'; fi
        owned && watchdog_alive
        exit $?;;
    start|restart|stop|ensure) lock || exit 1;;
    *) echo 'Usage: lifecycle.sh start|restart|stop|status|ensure'; exit 2;;
esac
case "$1" in
    start) start_daemon && start_watchdog;;
    ensure) start_daemon;;
    restart) stop_watchdog && stop_daemon && start_daemon && start_watchdog;;
    stop) stop_watchdog && stop_daemon;;
esac