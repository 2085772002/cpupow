#!/system/bin/sh
# 说明：本模块不拥有全局脚本或其他模块文件。
DIR=/data/adb/modules/cpupow
[ ! -x "$DIR/bin/lifecycle.sh" ] || sh "$DIR/bin/lifecycle.sh" stop
