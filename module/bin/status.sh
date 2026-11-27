#!/system/bin/sh
# 说明：只读运行状态入口；复用生命周期身份核验，不启动进程、不创建日志或状态文件。
DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd) || exit 1
[ "$DIR" = /data/adb/modules/cpupow ] || exit 2
state=$(sh "$DIR/bin/lifecycle.sh" status) || state=${state:-}
pid=$(printf '%s\n' "$state" | sed -n 's/^daemon_pids=//p')
case "$pid" in ''|*[!0-9]*) pid=null; running=false;; *) running=true;; esac
watchdog=false
printf '%s\n' "$state" | grep -qx 'watchdog=running' && watchdog=true
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
case "$boot" in ''|*[!a-f0-9-]*) exit 1;; esac
read -r uptime rest < /proc/uptime || exit 1
case "$uptime" in ''|*[!0-9.]*) exit 1;; esac
start=null
if [ "$running" = true ]; then
    read -r record_pid start record_boot < "$DIR/.daemon.pid" || exit 1
    if [ "$pid" != "$record_pid" ] || [ "$boot" != "$record_boot" ]; then
        running=false; pid=null; start=null
    fi
fi
case "$start" in null) :;; ''|*[!0-9]*) exit 1;; esac
disabled=false; removing=false
[ -e "$DIR/disable" ] && disabled=true
[ -e "$DIR/remove" ] && removing=true
printf '{"schema":1,"boot_id":"%s","checked_uptime_s":%s,"module":{"disabled":%s,"removing":%s},"daemon":{"running":%s,"pid":%s,"start_ticks":%s},"watchdog":{"running":%s},"runtime":' "$boot" "$uptime" "$disabled" "$removing" "$running" "$pid" "$start" "$watchdog"
# 说明：读取单次原子快照；缺失或过大时返回空值，由前端显示待确认而不是正常。
size=$(wc -c < "$DIR/runtime_status.json" 2>/dev/null) || size=0
case "$size" in ''|*[!0-9]*) size=0;; esac
if [ "$size" -gt 0 ] && [ "$size" -le 16384 ]; then
    cat "$DIR/runtime_status.json" || exit 1
else
    printf 'null'
fi
printf ',"policy":'
size=$(wc -c < "$DIR/policy_status.json" 2>/dev/null) || size=0
case "$size" in ''|*[!0-9]*) size=0;; esac
if [ "$size" -gt 0 ] && [ "$size" -le 32768 ]; then
    cat "$DIR/policy_status.json" || exit 1
else
    printf 'null'
fi
printf '}\n'