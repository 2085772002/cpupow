#!/system/bin/sh
# 说明：只读枚举处理器调频策略与 WALT 节点；测试可注入夹具根目录，不写硬件。
# 性能：用 shell 内建 read 读 sysfs（零 fork），避免每个节点 fork tr/awk，
# 显著降低配置页的设备发现延迟。
root=${CPUPOW_CPUFREQ_ROOT:-/sys/devices/system/cpu/cpufreq}
[ -d "$root" ] || { echo 'ERROR	未找到处理器调频目录'; exit 1; }
read_value() {
    if [ ! -e "$1" ]; then printf 'missing';
    elif [ ! -r "$1" ]; then printf 'unreadable';
    else IFS= read -r v < "$1" 2>/dev/null && printf '%s' "$v" || printf 'unreadable'; fi
}
found=0
for p in "$root"/policy[0-9]*; do
    [ -d "$p" ] || continue
    id=${p##*/policy}
    case "$id" in ''|*[!0-9]*) continue;; esac
    found=1
    printf 'POLICY\t%s\n' "$id"
    for key in related_cpus affected_cpus scaling_governor cpuinfo_min_freq cpuinfo_max_freq scaling_min_freq scaling_max_freq scaling_cur_freq; do
        printf 'VALUE\t%s\t%s\t' "$id" "$key"; read_value "$p/$key"; printf '\n'
    done
    if [ -r "$p/scaling_available_frequencies" ] && [ -s "$p/scaling_available_frequencies" ]; then
        printf 'FREQ\t%s\tavailable\t' "$id"; read_value "$p/scaling_available_frequencies"; printf '\n'
    elif [ -r "$p/stats/time_in_state" ]; then
        printf 'FREQ\t%s\ttime_in_state\t' "$id"
        while IFS= read -r line; do
            freq=${line%% *}
            case "$freq" in ''|*[!0-9]*) continue;; esac
            printf '%s ' "$freq"
        done < "$p/stats/time_in_state"
        printf '\n'
    else
        printf 'FREQ\t%s\tunavailable\t\n' "$id"
    fi
    for key in up_rate_limit_us down_rate_limit_us hispeed_load hispeed_freq hispeed_cond_freq rtg_boost_freq pl target_loads boost adaptive_level_1 adaptive_low_freq adaptive_high_freq zone_max_util_pct; do
        printf 'WALT\t%s\t%s\t' "$id" "$key"; read_value "$p/walt/$key"; printf '\n'
    done
done
[ "$found" = 1 ] || { printf 'ERROR\t没有可读取的 CPU 调频策略\n'; exit 1; }
printf 'END\t1\n'