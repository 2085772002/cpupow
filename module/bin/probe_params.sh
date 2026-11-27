#!/system/bin/sh
# 说明：安装时探测 WALT 参数支持性。先读当前值判断，判断不出再写测试值探测，探测后恢复原值。
# 只在安装阶段调用一次（此时守护进程已停止），不在配置页/高频路径调用。
# 输出：每行 "NEG<TAB><policy_id><TAB><0|1>"，1=boost 支持负数。
root=${CPUPOW_CPUFREQ_ROOT:-/sys/devices/system/cpu/cpufreq}
[ -d "$root" ] || exit 0

probe_negative() {
    path=$1
    [ -e "$path" ] || { printf 'missing'; return; }
    [ -r "$path" ] && [ -w "$path" ] || { printf 'unwritable'; return; }
    old=$(cat "$path" 2>/dev/null)
    case "$old" in
        ''|*[!0-9-]*) printf 'unreadable'; return;;
    esac
    # 说明：当前值已是负数，直接判定支持负数，不写测试值。
    case "$old" in
        -*) printf '1'; return;;
    esac
    # 说明：写 -1 测试，读回确认，然后恢复原值。
    if ! printf '%s' '-1' > "$path" 2>/dev/null; then
        printf '0'; return
    fi
    now=$(cat "$path" 2>/dev/null)
    printf '%s' "$old" > "$path" 2>/dev/null
    case "$now" in
        -1) printf '1';;
        *)  printf '0';;
    esac
}

for p in "$root"/policy[0-9]*; do
    [ -d "$p" ] || continue
    id=${p##*/policy}
    case "$id" in ''|*[!0-9]*) continue;; esac
    [ -e "$p/walt/boost" ] || continue
    support=$(probe_negative "$p/walt/boost")
    case "$support" in
        1|0) printf 'NEG\t%s\t%s\n' "$id" "$support";;
    esac
done
exit 0