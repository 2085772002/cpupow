# 说明：标准模块安装钩子。升级保留用户已有 CPU 配置与数据；仅在首次安装时生成作者默认。
OLD=${CPUPOW_INSTALL_OLD:-/data/adb/modules/cpupow}
preserved=0

# 说明：v2.5.9：升级时模块目录会被整体替换，锁文件换 inode——
# 旧守护进程仍锁着已删除的旧 inode，新实例照样能拿到锁，于是两个进程一起写 sysfs
# （真机日志里出现过：pid 记录 27736，runtime_status 却是 25870 在写）。
# 这里在动任何文件之前，按可执行文件路径把残留进程清干净：先 TERM，再 KILL。
# 只认本模块目录下的 cpupow，且只处理「无参数」的守护进程本体（放过 --diag / --check-config）。
cleanup_stray_daemons() {
    bin="$MODPATH/cpupow"
    [ -n "$bin" ] || return 0
    killed=0
    for d in /proc/[0-9]*; do
        [ -d "$d" ] || continue
        exe=$(readlink "$d/exe" 2>/dev/null) || continue
        # 说明：可执行文件被替换/删除后，readlink 会带 " (deleted)" 后缀，先去掉再比。
        exe=${exe% (deleted)}
        [ "$exe" = "$bin" ] || continue
        pid=${d#/proc/}
        [ "$pid" = "$$" ] && continue
        size=$(wc -c < "$d/cmdline" 2>/dev/null) || continue
        # 说明：只有 argv[0] 时 cmdline 长度等于路径长度 +1，这才是守护进程本体。
        [ "$size" -eq $(( ${#bin} + 1 )) ] || continue
        kill -TERM "$pid" 2>/dev/null && killed=$((killed+1))
    done
    [ "$killed" -gt 0 ] || return 0
    n=0
    while [ "$n" -lt 8 ]; do
        sleep 1; n=$((n+1))
        alive=0
        for d in /proc/[0-9]*; do
            [ -d "$d" ] || continue
            exe=$(readlink "$d/exe" 2>/dev/null) || continue
            exe=${exe% (deleted)}
            [ "$exe" = "$bin" ] || continue
            pid=${d#/proc/}
            [ "$pid" = "$$" ] && continue
            size=$(wc -c < "$d/cmdline" 2>/dev/null) || continue
            [ "$size" -eq $(( ${#bin} + 1 )) ] || continue
            kill -KILL "$pid" 2>/dev/null
            alive=1
        done
        [ "$alive" = 0 ] && break
    done
    ui_print "- 已清理 $killed 个残留旧守护进程"
}
cleanup_stray_daemons
# 说明：MODPATH 里已带配置（例如重复安装）则直接视为已保留。
if [ -f "$MODPATH/cpu_policy.json" ]; then preserved=1; fi
if [ "$OLD" != "$MODPATH" ] && [ -f "$OLD/module.prop" ]; then
    # 说明：尝试停止旧守护进程。旧版脚本在模块根，新版在 bin/，两种都兼容。
    # 停止失败不终止安装：新模块解压后已覆盖文件，服务重启时会用新二进制拉起；
    # 强制 abort 只会让用户卡在无法升级（旧 watchdog 杀不掉、pid 记录损坏等都会触发）。
    OLD_LIFECYCLE=""
    for cand in "$OLD/bin/lifecycle.sh" "$OLD/lifecycle.sh"; do
        [ -f "$cand" ] && { OLD_LIFECYCLE="$cand"; break; }
    done
    if [ -n "$OLD_LIFECYCLE" ]; then
        sh "$OLD_LIFECYCLE" stop || ui_print '! 旧守护进程停止未确认，继续安装；新版本服务启动时会重新拉起'
    else
        ui_print '! 未找到旧版 lifecycle.sh，跳过停止；若旧守护进程仍在运行，重启后生效'
    fi
    # 说明：保留 CPU 配置、界面回退副本、耗电历史、隐藏周期与手动模式。
    for f in cpu_policy.json .cpu-policy-ui-backup.json profile_battery.json cycle_hidden.txt manual_mode.txt; do
        [ ! -f "$OLD/$f" ] || cp -p "$OLD/$f" "$MODPATH/$f" || abort "Cannot preserve $f"
    done
    # 说明：v2.5.12：应用图标也保留。webroot/icons/*.png 是用 IconTool 逐个提取出来的，
    # 每个包都要起一次 app_process，一次全量提取要跑几十轮；升级后从头再来纯属浪费。
    # 只搬 .png（跳过 .keep 与杂物）；搬不动不算失败——图标是装饰，装完会自动重新提取。
    if [ -d "$OLD/webroot/icons" ]; then
        mkdir -p "$MODPATH/webroot/icons"
        kept=0
        failed=0
        for f in "$OLD/webroot/icons"/*.png; do
            [ -f "$f" ] || continue
            if cp -p "$f" "$MODPATH/webroot/icons/" 2>/dev/null; then
                kept=$((kept+1))
            else
                failed=$((failed+1))
            fi
        done
        if [ "$kept" -gt 0 ]; then
            ui_print "- 已保留应用图标 $kept 个（$failed 个失败，失败的会自动重新提取）"
        fi
    fi
    # 说明：pkg_rules.json 旧版在根、新版在 etc/，优先新位置再回退旧位置。
    if [ -f "$OLD/etc/pkg_rules.json" ]; then
        cp -p "$OLD/etc/pkg_rules.json" "$MODPATH/etc/pkg_rules.json" || abort "Cannot preserve pkg_rules.json"
    elif [ -f "$OLD/pkg_rules.json" ]; then
        cp -p "$OLD/pkg_rules.json" "$MODPATH/etc/pkg_rules.json" || abort "Cannot preserve pkg_rules.json"
    fi
    [ ! -f "$OLD/cpu_policy.json" ] || preserved=1
fi
if [ "$preserved" != 1 ]; then
    # 说明：首次安装才生成作者默认配置。
    generated="$MODPATH/.author-policy-install-$$.tmp"
    sh "$MODPATH/bin/author_policy.sh" 0 > "$generated" || { rm -f "$generated"; abort '作者默认生成失败，安装已终止'; }
    chmod 755 "$MODPATH/cpupow" || { rm -f "$generated"; abort '无法设置原生校验器执行权限'; }
    "$MODPATH/cpupow" --check-config "$generated" || { rm -f "$generated"; abort '作者默认校验失败，安装已终止'; }
    chmod 644 "$generated" && mv -f "$generated" "$MODPATH/cpu_policy.json" || { rm -f "$generated"; abort '作者默认配置落位失败'; }
    ui_print '- 首次安装：已按本机频点生成作者默认配置。'
else
    # 说明：v2.5.5 起 cpu_policy.json 改为「模式 × 频率区域 × 触摸阶段」结构。
    # 旧结构能被保留下来，但守护进程校验不通过就会拒绝写策略——那种状态很隐蔽
    # （模块"装上了"但调频不动），所以这里先校验：不认就备份原文再按本机频点重新生成。
    chmod 755 "$MODPATH/cpupow" 2>/dev/null || true
    if "$MODPATH/cpupow" --check-config "$MODPATH/cpu_policy.json" >/dev/null 2>&1; then
        ui_print '- 已逐字节保留现有 CPU 配置，未重新生成。'
    else
        ui_print '! 现有 CPU 配置是旧结构，不受当前版本支持'
        cp -p "$MODPATH/cpu_policy.json" "$MODPATH/cpu_policy.v2.json" || abort '旧配置备份失败，安装已终止'
        generated="$MODPATH/.author-policy-install-$$.tmp"
        sh "$MODPATH/bin/author_policy.sh" 0 > "$generated" || { rm -f "$generated"; abort '作者默认生成失败，安装已终止'; }
        "$MODPATH/cpupow" --check-config "$generated" || { rm -f "$generated"; abort '作者默认校验失败，安装已终止'; }
        chmod 644 "$generated" && mv -f "$generated" "$MODPATH/cpu_policy.json" || { rm -f "$generated"; abort '作者默认配置落位失败'; }
        ui_print '- 已按本机频点重新生成配置；旧文件保留为 cpu_policy.v2.json'
    fi
fi
set_perm_recursive "$MODPATH" 0 0 0755 0644
for f in cpupow service.sh uninstall.sh install.sh customize.sh; do
    set_perm "$MODPATH/$f" 0 0 0755
done
for f in lifecycle.sh watchdog.sh powercfg.sh status.sh author_policy.sh config_io.sh cpu_info.sh probe_params.sh diag.sh; do
    set_perm "$MODPATH/bin/$f" 0 0 0755
done
ui_print '- CPU/WALT 配置界面已安装。'
ui_print '- 配置页可按作者经验重新生成草稿；保存前不修改设备。'