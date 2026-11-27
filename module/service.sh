#!/system/bin/sh
# 说明：只启动通过身份核验的守护进程，不执行旧脚本或写入处理器分组。
TARGET_DIR="/data/adb/modules/cpupow"
LIFECYCLE="$TARGET_DIR/bin/lifecycle.sh"
log() { echo "[$(date '+%H:%M:%S')] $*"; }

until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
[ -x "$LIFECYCLE" ] || { log '缺少生命周期入口，停止启动'; exit 1; }
if ! sh "$LIFECYCLE" stop; then
    log '旧守护进程停止未确认，停止启动'
    exit 1
fi

MAX_WAIT=60
WAIT_COUNT=0
STABLE_COUNT=0
while [ "$STABLE_COUNT" -lt 3 ] && [ "$WAIT_COUNT" -lt "$MAX_WAIT" ]; do
    read -r cpu user nice system idle iowait irq softirq rest < /proc/stat
    total1=$((user + nice + system + idle + iowait + irq + softirq))
    idle1=$idle
    sleep 2
    read -r cpu user nice system idle iowait irq softirq rest < /proc/stat
    total2=$((user + nice + system + idle + iowait + irq + softirq))
    idle2=$idle
    delta_total=$((total2 - total1))
    [ "$delta_total" -gt 0 ] || delta_total=1
    idle_percent=$((100 * (idle2 - idle1) / delta_total))
    log "启动负载空闲率 ${idle_percent}% (${STABLE_COUNT}/3)"
    if [ "$idle_percent" -gt 50 ]; then STABLE_COUNT=$((STABLE_COUNT + 1)); else STABLE_COUNT=0; fi
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

if sh "$LIFECYCLE" start; then
    log '守护进程已启动'
else
    log "生命周期启动未确认，请检查 $TARGET_DIR/cpu_policy.log"
    exit 1
fi