#!/system/bin/sh
# 说明：一键导出诊断报告，供人工或自动化分析后端行为。
# 产物：/data/adb/modules/cpupow/diag-<时间>.txt
#
# 关键设计：日志「按类别全量提取」而不是只取末尾几百行。
#   早先只 tail 200 行，35 分钟打出来的 1MB 日志只能看到最后几秒，
#   性能快照（每 60 秒一条）与早期错误全被丢掉。
# 只读：不启动/停止服务，不写 sysfs，不改配置。
DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd) || exit 1
[ -d "$DIR" ] || { echo '模块目录不存在'; exit 1; }
LOG="$DIR/cpu_policy.log"
OUT="$DIR/diag-$(date '+%Y%m%d-%H%M%S').txt"

{
    echo '=== cpupow 诊断报告 ==='
    echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo

    echo '--- 模块元信息 ---'
    cat "$DIR/module.prop" 2>/dev/null
    echo

    echo '--- 设备 ---'
    echo "机型: $(getprop ro.product.model 2>/dev/null)"
    echo "SoC: $(getprop ro.soc.model 2>/dev/null)"
    echo "安卓: $(getprop ro.build.version.release 2>/dev/null)"
    echo "内核: $(uname -r 2>/dev/null)"
    echo

    echo '--- 守护进程身份 ---'
    echo "pid 记录: $(cat "$DIR/.daemon.pid" 2>/dev/null)"
    sh "$DIR/bin/lifecycle.sh" status 2>/dev/null
    echo

    echo '--- 结构化诊断 JSON（配置 / 频率 / 分区判定 / 运行快照含性能指标）---'
    "$DIR/cpupow" --diag 2>&1
    echo

    if [ -f "$LOG" ]; then
        TOTAL=$(wc -l < "$LOG" 2>/dev/null); case "$TOTAL" in ''|*[!0-9]*) TOTAL=0;; esac
        echo "--- 日志分类提取（总计 $TOTAL 行，$(wc -c < "$LOG" 2>/dev/null) 字节）---"
        echo

        echo '### 启动与配置加载（全部）'
        grep -E '^\[[0-9:.]+\]\[[IWE]\]\[(boot|cfg)' "$LOG" 2>/dev/null | head -n 200 || echo '(无)'
        echo

        echo '### 性能快照（全部，含每 60 秒一次的耗时与计数）'
        grep -F '][perf]' "$LOG" 2>/dev/null | tail -n 200 || echo '(无)'
        echo

        echo '### 错误与警告（全部 E/F/W）'
        grep -E '^\[[0-9:.]+\]\[[EFW]\]' "$LOG" 2>/dev/null | tail -n 300 || echo '(无)'
        echo

        echo '### 写入被改写（最多 80 条）'
        echo '说明：clamped_up=读回更高（如 min_freq 被 PM QoS 抬高）；'
        echo '      clamped_down=读回更低（如 max_freq 被温控压低）；different=其它不一致。'
        grep -E 'clamped|写入被改写|写入差异' "$LOG" 2>/dev/null | tail -n 80 || echo '(无)'
        echo

        echo '### 前台切换与模式（全部）'
        grep -F '][boot] focus' "$LOG" 2>/dev/null | tail -n 200 || echo '(无)'
        echo

        echo '### 触摸相位（最近 60 条）'
        grep -F '][tch ]' "$LOG" 2>/dev/null | tail -n 60 || echo '(无)'
        echo

        echo '### 分区进入（最近 80 条）'
        grep -F '][zone]' "$LOG" 2>/dev/null | grep -v 'cfg c=' | tail -n 80 || echo '(无)'
        echo

        echo '### 原始日志末尾 100 行（兜底）'
        tail -n 100 "$LOG" 2>/dev/null || echo '(无)'
    else
        echo '--- 日志文件不存在 ---'
    fi

    echo
    echo '--- 系统侧佐证：cpufreq 现状 ---'
    for p in /sys/devices/system/cpu/cpufreq/policy[0-9]*; do
        [ -d "$p" ] || continue
        cur=$(cat "$p/scaling_cur_freq" 2>/dev/null)
        mn=$(cat "$p/scaling_min_freq" 2>/dev/null)
        mx=$(cat "$p/scaling_max_freq" 2>/dev/null)
        hwmn=$(cat "$p/cpuinfo_min_freq" 2>/dev/null)
        hwmx=$(cat "$p/cpuinfo_max_freq" 2>/dev/null)
        echo "[${p##*/}] cur=$cur min=$mn max=$mx hw_min=$hwmn hw_max=$hwmx"
        # 说明：max 低于 hw_max 说明有其它子系统（温控 / PowerHAL / qcom limits）在压上限。
        case "$mx" in ''|*[!0-9]*) ;; *) case "$hwmx" in ''|*[!0-9]*) ;; *)
            [ "$mx" -lt "$hwmx" ] && echo "        !! max 被外部压低 $(( (hwmx-mx)/1000 )) MHz（温控/PowerHAL）"
        ;; esac ;; esac
        case "$mn" in ''|*[!0-9]*) ;; *) case "$hwmn" in ''|*[!0-9]*) ;; *)
            [ "$mn" -gt "$hwmn" ] && echo "        !! min 被外部抬高 $(( (mn-hwmn)/1000 )) MHz（PM QoS 请求）"
        ;; esac ;; esac
        echo "        walt/boost=$(cat "$p/walt/boost" 2>/dev/null) target_loads=$(cat "$p/walt/target_loads" 2>/dev/null)"
    done

    echo
    echo '--- 温控与限频证据（判断谁在压 max）---'
    for z in /sys/class/thermal/thermal_zone*; do
        [ -d "$z" ] || continue
        name=$(cat "$z/type" 2>/dev/null)
        temp=$(cat "$z/temp" 2>/dev/null)
        case "$name" in *cpu*|*cpufreq*|*limit*|*cluster*|*gpu*)
            echo "[${z##*/}] type=$name temp=$temp"
        ;; esac
    done
    echo
    echo '冷却设备限频状态：'
    for c in /sys/class/thermal/cooling_device*; do
        [ -d "$c" ] || continue
        ct=$(cat "$c/type" 2>/dev/null)
        cs=$(cat "$c/cur_state" 2>/dev/null)
        ms=$(cat "$c/max_state" 2>/dev/null)
        case "$ct" in *cpu*|*cpufreq*|*limit*)
            echo "  [$ct] state=$cs/$ms"
        ;; esac
    done
    echo
    echo '图标缓存状态：'
    ICON_DIR="$DIR/webroot/icons"
    if [ -d "$ICON_DIR" ]; then
        ICON_N=$(ls -1 "$ICON_DIR"/*.png 2>/dev/null | wc -l)
        echo "  已缓存图标: $ICON_N 个"
        echo "  最近 10 个:"; ls -1t "$ICON_DIR"/*.png 2>/dev/null | head -10 | sed 's|.*/|    |'
    else
        echo "  图标目录不存在: $ICON_DIR"
    fi
    echo "  IconTool: $(ls -la "$DIR/webroot/tool/classes.dex" 2>/dev/null || echo '缺少 classes.dex')"
    echo
    echo '应用规则（决定各应用用哪个模式）：'
    if [ -f "$DIR/etc/pkg_rules.json" ]; then
        cat "$DIR/etc/pkg_rules.json" 2>/dev/null
        RULE_COUNT=$(grep -o '"pkg"' "$DIR/etc/pkg_rules.json" 2>/dev/null | wc -l)
        echo "  → 已配置 $RULE_COUNT 条应用规则；若为 0，所有应用都走 default 模式"
    else
        echo '  (无规则文件，所有应用走内置默认)'
    fi
    echo
    echo 'WALT 侧限制参数：'
    for p in /sys/devices/system/cpu/cpufreq/policy[0-9]*; do
        [ -d "$p/walt" ] || continue
        echo "  [${p##*/}] hispeed_cond_freq=$(cat "$p/walt/hispeed_cond_freq" 2>/dev/null) rtg_boost_freq=$(cat "$p/walt/rtg_boost_freq" 2>/dev/null) adaptive_high_freq=$(cat "$p/walt/adaptive_high_freq" 2>/dev/null)"
    done
} > "$OUT" 2>&1

echo "诊断报告已生成: $OUT"
echo "大小: $(wc -c < "$OUT") 字节"
echo "请把这个文件发给分析者。"
echo "$OUT"