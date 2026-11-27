#!/system/bin/sh
# 说明：配置文件事务入口，校验候选、检测并发、保留回退副本并原子提交；不直接写 sysfs。
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
file="$base/cpu_policy.json"
fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
# 说明：Android mksh 默认将 hash 定义为别名，使用专有函数名防止调用被展开成命令缓存操作。
policy_sha256() {
    output=$(sha256sum "$1") || return 1
    value=${output%% *}
    case "$value" in ''|*[!a-f0-9]*) return 1;; esac
    [ "${#value}" = 64 ] || return 1
    printf '%s' "$value"
}
case "${1:-}" in
read)
    [ -r "$file" ] || fail 'CPU 配置文件不可读'
    before=$(policy_sha256 "$file") || fail 'CPU 配置指纹读取失败'
    printf 'CPPOLICY\t%s\n' "$before"
    cat "$file" || fail 'CPU 配置内容读取失败'
    after=$(policy_sha256 "$file") || fail 'CPU 配置复核指纹读取失败'
    printf '\nCPEND\t%s\n' "$after"
    ;;
save)
    expected=${2:-}; token=${3:-}
    case "$expected" in ''|*[!a-f0-9]*) fail '配置指纹无效';; esac
    [ "${#expected}" = 64 ] || fail '配置指纹长度无效'
    case "$token" in ''|*[!a-zA-Z0-9_-]*) fail '事务标识无效';; esac
    [ "${#token}" -le 80 ] || fail '事务标识过长'
    candidate="$base/.cpu-policy-candidate-$token.json"
    [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail '候选配置不存在'
    [ "$(wc -c < "$candidate")" -le 131072 ] || fail '配置过大'
    lock="$base/.cpu-policy-ui.lock"
    mkdir "$lock" 2>/dev/null || fail '配置正在被其他操作保存，请稍后重试' 3
    trap 'rm -f "$candidate"; rmdir "$lock" 2>/dev/null' EXIT
    trap 'exit 1' HUP INT TERM
    [ "$(policy_sha256 "$file")" = "$expected" ] || fail '配置已被其他页面或程序修改，请重新读取后调整' 4
    "$base/cpupow" --check-config "$candidate" >/dev/null || fail '后端校验失败，原配置未修改' 5
    backup="$base/.cpu-policy-ui-backup.json"
    temp="$base/.cpu-policy-ui-backup-$token.tmp"
    cp "$file" "$temp" && chmod 600 "$temp" && mv -f "$temp" "$backup" || { rm -f "$temp"; fail '备份失败，原配置未修改'; }
    candidate_hash=$(policy_sha256 "$candidate") || fail '候选配置指纹读取失败'
    chmod 644 "$candidate" || fail '候选文件权限设置失败'
    [ "$(policy_sha256 "$file")" = "$expected" ] || fail '校验期间配置发生变化，原配置未覆盖' 4
    mv -f "$candidate" "$file" || fail '配置提交失败'
    actual=$(policy_sha256 "$file") || fail '提交后无法读取配置，回退副本已保留'
    if [ "$actual" != "$candidate_hash" ]; then fail '提交后内容与候选不一致，请检查其他配置写入程序；回退副本已保留' 6; fi
    printf 'CPSAVED\t%s\t%s\n' "$actual" "$backup"
    ;;
*) fail '配置事务操作无效';;
esac