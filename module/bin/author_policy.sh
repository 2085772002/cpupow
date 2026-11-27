#!/system/bin/sh
# 说明：安装与界面共用的只读生成入口（探测阶段会有一次写测试值并立即恢复）。
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
level=${1:-0}
case "$level" in 0|1|2|3) ;; *) printf '日志级别无效\n' >&2; exit 1;; esac
# 说明：先探测参数支持性（如 boost 是否支持负数），再枚举 CPU 频率；两者一起交给生成器。
probe=$(sh "$base/probe_params.sh" 2>/dev/null) || probe=""
info=$(sh "$base/cpu_info.sh") || { printf '无法发现 CPU 频率，未生成配置\n' >&2; exit 1; }
printf '%s\n%s\n' "$probe" "$info" | awk -v log_level="$level" -f "$base/author_policy.awk"
