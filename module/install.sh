ui_print() { echo "$1"; }
# 说明：提取 module.prop
unzip -o "$ZIPFILE" module.prop -d $TMPDIR >&2
[ ! -f $TMPDIR/module.prop ] && {
  ui_print "! 无法提取 zip 文件！"
  exit 1
}
ui_print " "
ui_print "***************************"
ui_print " $MODNAME "
ui_print " by $MODAUTH"
ui_print "***************************"
ui_print " "

# 说明：解压所有文件（排除 META-INF）
ui_print "- 正在解压所有文件..."
unzip -o "$ZIPFILE" -x 'META-INF/*' -d $MODPATH >&2

# 说明：按设备架构从 lib/<abi>/ 选择 cpupow 二进制
case "$ARCH" in
  arm64) ABI_DIR=arm64-v8a ;;
  arm)   ABI_DIR=armeabi-v7a ;;
  x64)   ABI_DIR=x86_64 ;;
  *)     ui_print "! 不支持的设备架构: $ARCH"; exit 1 ;;
esac
ui_print "- 设备架构: $ARCH ($ABI_DIR)"
cp "$MODPATH/lib/$ABI_DIR/cpupow" "$MODPATH/cpupow" || {
  ui_print "! 缺少 $ABI_DIR 的 cpupow 二进制"
  exit 1
}

# 说明：按标准安装钩子设置最小可用权限
[ -f "$MODPATH/customize.sh" ] || exit 1
. "$MODPATH/customize.sh"