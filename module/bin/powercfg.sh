#!/system/bin/sh
# 说明：兼容入口只记录意图，处理器写入仍须由有效手动配置授权。
[ "$#" -eq 1 ] || exit 2
case "$1" in powersave|balance|performance|fast) ;; *) exit 2;; esac
printf '%s\n' "$1" > /data/adb/modules/cpupow/manual_mode.txt