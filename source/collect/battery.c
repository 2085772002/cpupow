/* 说明：独立耗电采集器拥有有界充放电计数和现有十一列历史，不包含处理器画像或学习；仅采样线程拥有计数，快照原子替换，覆盖时长使用开机时钟，墙钟仅用于历史时间戳。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../output/status.h"
#include "../cpupow.h"
#include "./network_kind.h"
#include "./network.h"
#include "chg_state.h"
#include "touch.h"
#include <math.h>
#define BATT_HIST_MAX 1500
#define BATT_HIST_PKGS 96
#define BATT_PLUG_MAX 8
#ifndef BATT_GAP_MAX_MS
#define BATT_GAP_MAX_MS 300000LL
#endif
static const char *g_bucket_names[3]={"on_touch","on_idle","off"};
typedef struct {
 char pkg[128]; unsigned long long ms,pwr_n,t_n;
 double pwr_sum,tmax,t_sum;
} BattApp;
static BattApp g_batt_apps[BATT_MAX_APPS];
static int g_batt_napps;
static unsigned long long g_batt_bucket_ms[3],g_batt_touch_ms,g_batt_on_ms,g_batt_off_ms;
static unsigned long long g_batt_charge_ms,g_batt_run_ms,g_batt_samples;
static pthread_mutex_t g_batt_mtx=PTHREAD_MUTEX_INITIALIZER;
static char  g_screen_path[160] = {0};
static int   g_screen_kind = 0;   /* 说明：0 = brightness(>0 亮)；1 = bl_power(0 亮) */
static int   g_screen_probe_ok = 0;

/* 说明：充电状态检测（v1.6.0）：优先 battery/status(Charging 字符串)，次选 power_supply 下的 online 节点(>0)。
 * 探测失败恒按放电退化，不产生错误数据结构。
 */
static char  g_charge_path[160] = {0};
static int   g_charge_kind = 0;   /* 说明：0 = status(Charging 字符串)；1 = online(整数 >0) */
static int   g_charge_probe_ok = 0;

/* 说明：v1.25.0（dump v15）：插电检测（充电器在线），与"是否在充电"解耦。
 * 满电 100% 插着充电器时电池 status 仍在 Charging/Discharging 间摆动，
 * 只按 status 判"拔电/插电"必然误判（实测见 chg_state.h 文件头）。
 * 这里把所有 power_supply 设备的 online 节点收集起来，任一 >0 即视为插电。
 * 全部探测不到时 batt_plugged() 返回 -1，上层退回只看 status 的旧口径。
 */
static char  g_plug_paths[BATT_PLUG_MAX][160];
static char  g_plug_devs[BATT_PLUG_MAX][48];
static int   g_plug_n = 0;

/* 说明：温度/功耗采样（v1.7.0）：电池功率 = |current_now|×voltage_now；温度取电池 temp 与
 * 全部 thermal_zone 最大值。探测失败的项不累计（n=0），UI 显示"-"，不产生错误数据。
 */
static char  g_pwr_i_path[160] = {0};  /* 说明：电池电流，单位微安。 */
static char  g_pwr_v_path[160] = {0};  /* 说明：电池电压，单位微伏。 */
static int   g_pwr_probe_ok = 0;
static char  g_pwr_dev[48] = {0};      /* 说明：实际选中的功率设备名（v1.10.0，dump 如实上报） */
static char  g_batt_t_path[160] = {0}; /* 说明：电池温度，单位零点一摄氏度。 */
static int   g_batt_t_probe_ok = 0;
static char  g_batt_t_dev[48] = {0};   /* 说明：实际选中的温度设备名（v1.10.0） */
static char  g_thermal_paths[96][160]; /* 说明：thermal_zone 下各 temp 节点（m°C） */
static int   g_thermal_n = 0;
static double g_batt_pwr_sum[BATT_BUCKET_COUNT];      /* 说明：每桶功率累计（mW） */
static unsigned long long g_batt_pwr_n[BATT_BUCKET_COUNT]; /* 说明：有效功率样本数 */
static double g_batt_pwr_max = 0;                     /* 说明：全程峰值功率（mW） */
static double g_batt_batt_t_sum = 0;                  /* 说明：电池温度累计（°C，v1.11.0 起仅放电期） */
/* 说明：v1.11.0：充放电分侧统计——充电期电池温度受充电发热影响，与放电期口径不同不可混 */
static double g_batt_chg_batt_t_sum = 0;              /* 说明：充电期电池温度累计（°C） */
static double g_batt_chg_batt_t_max = -1000;          /* 说明：充电期电池温度峰值（°C） */
static long long g_batt_chg_batt_t_n = 0;             /* 说明：充电期温度样本数 */
static double g_batt_dis_mah = 0;                     /* 说明：放电累计电量（mAh，charge_counter 差分） */
static double g_batt_chg_mah = 0;                     /* 说明：充电累计电量（mAh） */
static double g_batt_dis_pwr_sum = 0;                 /* 说明：放电期功率累计（mW，v1.11.0 分侧） */
static long long g_batt_dis_pwr_n = 0;                /* 说明：放电期功率样本数 */
static double g_batt_chg_pwr_sum = 0;                 /* 说明：充电期功率累计（mW） */
static long long g_batt_chg_pwr_n = 0;                /* 说明：充电期功率样本数 */
static long long g_batt_cc_prev = -1;                 /* 说明：charge_counter 上次值（µAh），-1=未定基线 */
static int   g_cc_probe_ok = 0;                       /* 说明：charge_counter 节点可读 */
static char  g_cc_path[160] = {0};                    /* 说明：电池累计电量计数节点。 */
/* 说明：v1.13.0（dump v10）：电量+前台时间序列（耗电统计页曲线/泳道数据源）。
 * 每 60s 记一点：unix 秒、电量%、前台包名索引（-1=无前台）、屏幕状态（v1.14.0/v11：1=亮屏 0=息屏 -1=未知）。
 * 点数满 BATT_HIST_MAX 时 memmove 覆盖最旧，长期运行保持约 25h 窗口。
 */
static long long g_batt_hist_t[BATT_HIST_MAX];        /* 说明：unix 秒 */
static short g_batt_hist_cap[BATT_HIST_MAX];          /* 说明：电量 %（0-100） */
static short g_batt_hist_fg[BATT_HIST_MAX];           /* 说明：g_hist_pkgs 索引，-1=无前台 */
static short g_batt_hist_scr[BATT_HIST_MAX];          /* 说明：屏幕状态 1/0/-1（v1.14.0 曲线实虚线分段） */
/* 说明：v1.18.0（dump v13）：hist 扩展——充放状态 + 记录时刻功率/温度，
 * 支撑耗电页放电周期切分与曲线单点悬浮详情（旧数据 restore 时置默认）
 */
static short g_batt_hist_chg[BATT_HIST_MAX];          /* 说明：1=充电 0=放电 -1=未知 */
/* 说明：v1.22.0（dump v14）：hist 追加触摸标记，支撑「应用耗电排行」按
 * 全部 / 亮屏 / 触摸 / 息屏 四档拆分。1=该针时刻处于触摸（且亮屏），
 * 0=亮屏但未触摸，-1=息屏或无触摸语义（旧数据恢复时为 -1）。
 */
static short g_batt_hist_touch[BATT_HIST_MAX];
/* 说明：v1.25.0（dump v15）：hist 追加插电标记，把"插着电"与"在充电"分开。
 * 1=该针时刻充电器在线，0=未插电，-1=旧数据/节点不可用（未知）。
 * 用途：满电 100% 插着充电器时，曲线上这一针是"已充满"而不是"充电中"——
 * chg 位（第5位）只表示"电池真在充入"，插电标记负责说明"电还插着"。
 */
static short g_batt_hist_plg[BATT_HIST_MAX];
static short g_batt_hist_net[BATT_HIST_MAX];         /* 说明：v16: -1未知/0无/1WLAN/2蜂窝/3其他 */
static int g_batt_net = NET_KIND_UNKNOWN;
static long long g_batt_net_at_ms = -1;
static float g_batt_hist_mw[BATT_HIST_MAX];           /* 说明：记录时刻整机功率 mW（0=无） */
static float g_batt_hist_bt[BATT_HIST_MAX];           /* 说明：记录时刻电池温度 °C（0=无） */
static float g_batt_hist_ct[BATT_HIST_MAX];           /* 说明：记录时刻 CPU 结温 °C（0=无） */
static int   g_batt_hist_n = 0;                       /* 说明：当前点数 */
static long long g_hist_last_t = 0;                   /* 说明：上次记录 unix 秒（0=未记录） */
/* 说明：v1.24.0：真实经过时间锚点（CLOCK_BOOTTIME 毫秒；0=尚未采过样）。
 * 场景时长改按相邻两次采样的实际间隔累计，取代「固定 interval*1000」的估算。
 */
static long long g_batt_last_mono_ms = 0;
/* 说明：停机判定阈值：与前端 hist 复算同口径（views_battery.js cycStats 的 300s）。
 * 间隔超过该值说明采样线程没在跑（进程被杀/设备深度休眠），这段时间里屏幕
 * 状态不可判断——宁可少算，不编造，与「守护停机不计入」的既有口径一致。
 * 允许编译期覆盖：仅用于验证「停机夹断」分支（测试用 -DBATT_GAP_MAX_MS=3000）。
 */
#ifndef BATT_GAP_MAX_MS
#define BATT_GAP_MAX_MS 300000LL
#endif
static char  g_hist_pkgs[BATT_HIST_PKGS][96];         /* 说明：泳道包名表（只增不删，索引稳定） */
static int   g_batt_hist_np = 0;                      /* 说明：包名表数量 */
static int   g_cap_probe_ok = 0;                      /* 说明：battery/capacity 节点可读 */
static char  g_cap_path[160] = {0};                   /* 说明：电池剩余容量节点。 */
static long long g_batt_full_ua = 0;                  /* 说明：charge_full（µAh），理论续航估算用 */
static unsigned long long g_batt_batt_t_n = 0;
static double g_batt_batt_t_max = -1000;              /* 说明：电池温度峰值（°C） */
static double g_batt_cpu_t_max = -1000;               /* 说明：CPU/GPU 结温峰值（°C） */

static long long g_full_at_s = 0;   /* 说明：上次充满（电量首次到 100% 且插电）时刻，unix 秒 */
static long long g_plug_at_s = 0;   /* 说明：上次插电（充电器上线）时刻，unix 秒 */
static int g_prev_state=-1,g_prev_plug=-1;
static long long g_prev_cap=-1;
static void batt_probe_screen(void)
{
    DIR *d = opendir("/sys/class/backlight");
    if (!d) return;
    struct dirent *de;
    rewinddir(d);
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char p[160];
        snprintf(p, sizeof(p), "/sys/class/backlight/%s/brightness", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_screen_path, sizeof(g_screen_path), "%s", p);
            g_screen_kind = 0;
            g_screen_probe_ok = 1;
            closedir(d);
            return;
        }
    }
    rewinddir(d);
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char p[160];
        snprintf(p, sizeof(p), "/sys/class/backlight/%s/bl_power", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_screen_path, sizeof(g_screen_path), "%s", p);
            g_screen_kind = 1;
            g_screen_probe_ok = 1;
            break;
        }
    }
    closedir(d);
}

/* 说明：手写取首个整数：避开 glibc C23 对 fscanf/strtol 的符号重定向（compat 层无垫片） */
static int batt_parse_int(const char *s, size_t n)
{
    int v = -1;
    for (size_t k = 0; k < n; k++) {
        if (s[k] >= '0' && s[k] <= '9') {
            if (v < 0) v = 0;
            v = v * 10 + (s[k] - '0');
        } else if (v >= 0) break;
    }
    return v;
}

/* 说明：1=亮屏 0=息屏；无可用节点时恒 1（退化为亮屏口径，不产生错误数据结构） */
static int batt_screen_on(void)
{
    if (!g_screen_probe_ok) return 1;
    FILE *fp = fopen(g_screen_path, "r");
    if (!fp) return 1;
    char lb[32] = {0};
    size_t got = fread(lb, 1, sizeof(lb) - 1, fp);
    fclose(fp);
    if (got == 0) return 1;
    int v = batt_parse_int(lb, got);
    if (v < 0) return 1;
    if (g_screen_kind == 0) return v > 0 ? 1 : 0; /* 说明：brightness: >0 = 亮 */
    return v == 0 ? 1 : 0;                        /* 说明：bl_power: 0 = 亮（FB_BLANK_UNBLANK） */
}

/* 说明：充电节点探测：先所有设备的 status（Charging 语义最直接），再退到 online */
static void batt_probe_charge(void)
{
    DIR *d = opendir("/sys/class/power_supply");
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char p[160];
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/status", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_charge_path, sizeof(g_charge_path), "%s", p);
            g_charge_kind = 0;
            g_charge_probe_ok = 1;
            closedir(d);
            return;
        }
    }
    rewinddir(d);
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char p[160];
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/online", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_charge_path, sizeof(g_charge_path), "%s", p);
            g_charge_kind = 1;
            g_charge_probe_ok = 1;
            break;
        }
    }
    closedir(d);
}

/* 说明：1=充电 0=放电；无可用节点时恒 0（按放电退化） */
static int batt_charging(void)
{
    if (!g_charge_probe_ok) return 0;
    FILE *fp = fopen(g_charge_path, "r");
    if (!fp) return 0;
    char lb[48] = {0};
    size_t got = fread(lb, 1, sizeof(lb) - 1, fp);
    fclose(fp);
    if (!got) return 0;
    if (g_charge_kind == 0) return strncmp(lb, "Charging", 8) == 0; /* 说明：Full/Not charging/Discharging 均非充电 */
    return batt_parse_int(lb, got) > 0;
}

/* 说明：v1.25.0：插电节点探测（充电器是否在线）。枚举 /sys/class/power_supply 下
 * 所有设备，凡有可读 online 的都收进表里（usb / ac / wireless / usbpd ...），
 * 查询时任一 >0 即插电。online 是"电源在不在"，与"电池在不在充电"是两回事——
 * 满电后 status 会摆、online 不会。
 */
static long long batt_read_ll(const char *path); /* 说明：定义在本节之后（带符号解析） */
static void batt_probe_plug(void)
{
    DIR *d = opendir("/sys/class/power_supply");
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        if (g_plug_n >= BATT_PLUG_MAX) break;
        char p[160];
        snprintf(p, sizeof(p), "/sys/class/power_supply/%s/online", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_plug_paths[g_plug_n], sizeof(g_plug_paths[0]), "%s", p);
            snprintf(g_plug_devs[g_plug_n], sizeof(g_plug_devs[0]), "%s", de->d_name);
            g_plug_n++;
        }
    }
    closedir(d);
}

/* 说明：1=插着充电器 0=未插 -1=无可用节点（未知，调用方退回按 status 判定） */
static int batt_plugged(void)
{
    if (g_plug_n <= 0) return -1;
    for (int i = 0; i < g_plug_n; i++)
        if (batt_read_ll(g_plug_paths[i]) > 0) return 1;
    return 0;
}

/* 说明：带符号 64 位手写解析：电流放电可能为负，温度可能为负；同样避开 fscanf/strtol 重定向 */
static long long batt_parse_ll(const char *s, size_t n)
{
    long long v = 0;
    int neg = 0, got_any = 0;
    for (size_t k = 0; k < n; k++) {
        char c = s[k];
        if (c == '-' && !got_any) { neg = 1; continue; }
        if (c >= '0' && c <= '9') {
            v = v * 10 + (c - '0');
            got_any = 1;
        } else if (got_any) break;
    }
    if (!got_any) return 0;
    return neg ? -v : v;
}

static long long batt_read_ll(const char *path)
{
    FILE *fp = fopen(path, "r");
    if (!fp) return 0;
    char lb[48] = {0};
    size_t got = fread(lb, 1, sizeof(lb) - 1, fp);
    fclose(fp);
    return batt_parse_ll(lb, got);
}

static void batt_probe_power(void)
{
    DIR *d = opendir("/sys/class/power_supply");
    if (!d) return;
    struct dirent *de;
    char fb_i[176] = {0}, fb_v[176] = {0}, fb_t[176] = {0};
    char fb_pdev[48] = {0}, fb_tdev[48] = {0};
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        int is_batt = strcmp(de->d_name, "battery") == 0;
        char pi[176], pv[176], pt[176];
        snprintf(pi, sizeof(pi), "/sys/class/power_supply/%s/current_now", de->d_name);
        snprintf(pv, sizeof(pv), "/sys/class/power_supply/%s/voltage_now", de->d_name);
        snprintf(pt, sizeof(pt), "/sys/class/power_supply/%s/temp", de->d_name);
        if (access(pi, R_OK) == 0 && access(pv, R_OK) == 0) {
            if (is_batt) {
                snprintf(g_pwr_i_path, sizeof(g_pwr_i_path), "%s", pi);
                snprintf(g_pwr_v_path, sizeof(g_pwr_v_path), "%s", pv);
                snprintf(g_pwr_dev, sizeof(g_pwr_dev), "%s", de->d_name);
                g_pwr_probe_ok = 1;
            } else if (!fb_pdev[0]) {
                snprintf(fb_i, sizeof(fb_i), "%s", pi);
                snprintf(fb_v, sizeof(fb_v), "%s", pv);
                snprintf(fb_pdev, sizeof(fb_pdev), "%s", de->d_name);
            }
        }
        if (access(pt, R_OK) == 0) {
            if (is_batt) {
                snprintf(g_batt_t_path, sizeof(g_batt_t_path), "%s", pt);
                snprintf(g_batt_t_dev, sizeof(g_batt_t_dev), "%s", de->d_name);
                g_batt_t_probe_ok = 1;
            } else if (!fb_tdev[0]) {
                snprintf(fb_t, sizeof(fb_t), "%s", pt);
                snprintf(fb_tdev, sizeof(fb_tdev), "%s", de->d_name);
            }
        }
    }
    closedir(d);
    /* 说明：无 battery 设备时退回第一个可用的（老设备/命名异常） */
    if (!g_pwr_probe_ok && fb_pdev[0]) {
        snprintf(g_pwr_i_path, sizeof(g_pwr_i_path), "%s", fb_i);
        snprintf(g_pwr_v_path, sizeof(g_pwr_v_path), "%s", fb_v);
        snprintf(g_pwr_dev, sizeof(g_pwr_dev), "%s", fb_pdev);
        g_pwr_probe_ok = 1;
    }
    if (!g_batt_t_probe_ok && fb_tdev[0]) {
        snprintf(g_batt_t_path, sizeof(g_batt_t_path), "%s", fb_t);
        snprintf(g_batt_t_dev, sizeof(g_batt_t_dev), "%s", fb_tdev);
        g_batt_t_probe_ok = 1;
    }
    /* 说明：v1.11.0：charge_counter 探测（µAh），充放电电量差分统计用。
 * 仅取 battery 设备；读失败时差分跳过，不产生错误数据。
 */
    if (access("/sys/class/power_supply/battery/charge_counter", R_OK) == 0) {
        snprintf(g_cc_path, sizeof(g_cc_path), "/sys/class/power_supply/battery/charge_counter");
        g_cc_probe_ok = 1;
    }
    /* 说明：v1.13.0：电量%与电池总容量探测（耗电统计页曲线/理论续航用） */
    if (access("/sys/class/power_supply/battery/capacity", R_OK) == 0) {
        snprintf(g_cap_path, sizeof(g_cap_path), "/sys/class/power_supply/battery/capacity");
        g_cap_probe_ok = 1;
    }
    g_batt_full_ua = batt_read_ll("/sys/class/power_supply/battery/charge_full");
}

/* 说明：结温节点探测：枚举 thermal_zone 下各 temp 节点，上限 96 个，全取最大值。
 * v1.10.0 修正：跳过非测温 zone——cpu-hw-trip-* 报的是跳闸阈值（恒 95000），
 * bcl/ibat-lvl 报电流门限、vbat 报电压，混入会把结温峰值顶死在 95°C。
 */
static void batt_probe_thermal(void)
{
    DIR *d = opendir("/sys/class/thermal");
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (strncmp(de->d_name, "thermal_zone", 12) != 0) continue;
        if (g_thermal_n >= 96) break;
        char tp[196], tb[64];
        snprintf(tp, sizeof(tp), "/sys/class/thermal/%s/type", de->d_name);
        FILE *tf = fopen(tp, "r");
        if (tf) {
            size_t got = fread(tb, 1, sizeof(tb) - 1, tf);
            fclose(tf);
            tb[got] = '\0';
            if (strstr(tb, "trip") || strstr(tb, "lvl") || strstr(tb, "vbat") ||
                strstr(tb, "ibat") || strstr(tb, "bcl"))
                continue;
        }
        char p[176];
        snprintf(p, sizeof(p), "/sys/class/thermal/%s/temp", de->d_name);
        if (access(p, R_OK) == 0) {
            snprintf(g_thermal_paths[g_thermal_n], sizeof(g_thermal_paths[0]), "%s", p);
            g_thermal_n++;
        }
    }
    closedir(d);
}

/* 说明：电池瞬时功率（mW）：|µA|×µV÷1e9；探测失败返回 -1 表示本周期不计 */
static double batt_read_power_mw(void)
{
    if (!g_pwr_probe_ok) return -1.0;
    long long i = batt_read_ll(g_pwr_i_path);
    long long v = batt_read_ll(g_pwr_v_path);
    if (v <= 0) return -1.0;
    double mw = ((double)(i < 0 ? -i : i)) * ((double)v) / 1e9;
    return mw > 0 ? mw : -1.0;
}

/* 说明：电池温度（°C）：节点单位 0.1°C；失败返回 -1000 表示不计 */
static double batt_read_batt_temp_c(void)
{
    if (!g_batt_t_probe_ok) return -1000.0;
    return (double)batt_read_ll(g_batt_t_path) / 10.0;
}

/* 说明：CPU/GPU 结温最大值（°C）：节点单位 m°C；无节点返回 -1000 表示不计 */
static double batt_read_cpu_temp_c(void)
{
    double mx = -1000.0;
    for (int i = 0; i < g_thermal_n; i++) {
        double t = (double)batt_read_ll(g_thermal_paths[i]) / 1000.0;
        if (t > mx) mx = t;
    }
    return mx;
}

static void batt_app_add(const char *pkg, unsigned long long ms, double mw, double tmax)
{
    for (int i = 0; i < g_batt_napps; i++) {
        if (strcmp(g_batt_apps[i].pkg, pkg) == 0) {
            g_batt_apps[i].ms += ms;
            if (mw > 0) { g_batt_apps[i].pwr_sum += mw; g_batt_apps[i].pwr_n++; }
            if (tmax > g_batt_apps[i].tmax) g_batt_apps[i].tmax = tmax;
            /* 说明：v1.14.0：温度样本累计（tmax>0 才算有效读数，0=读失败不污染均值） */
            if (tmax > 0) { g_batt_apps[i].t_sum += tmax; g_batt_apps[i].t_n++; }
            return;
        }
    }
    if (g_batt_napps < BATT_MAX_APPS) {
        memset(&g_batt_apps[g_batt_napps], 0, sizeof(g_batt_apps[0]));
        snprintf(g_batt_apps[g_batt_napps].pkg,
                 sizeof(g_batt_apps[0].pkg), "%s", pkg);
        g_batt_apps[g_batt_napps].ms = ms;
        g_batt_apps[g_batt_napps].pwr_sum = (mw > 0) ? mw : 0;
        g_batt_apps[g_batt_napps].pwr_n = (mw > 0) ? 1 : 0;
        g_batt_apps[g_batt_napps].tmax = tmax > 0 ? tmax : 0;
        g_batt_apps[g_batt_napps].t_sum = tmax > 0 ? tmax : 0;
        g_batt_apps[g_batt_napps].t_n = tmax > 0 ? 1 : 0;
        g_batt_napps++;
        return;
    }
    /* 说明：表满：淘汰占用最小者，但新条目至少要超过它才值得替换 */
    int min_i = 0;
    for (int i = 1; i < g_batt_napps; i++)
        if (g_batt_apps[i].ms < g_batt_apps[min_i].ms) min_i = i;
    if (ms > g_batt_apps[min_i].ms) {
        memset(&g_batt_apps[min_i], 0, sizeof(g_batt_apps[0]));
        snprintf(g_batt_apps[min_i].pkg, sizeof(g_batt_apps[min_i].pkg), "%s", pkg);
        g_batt_apps[min_i].ms = ms;
        g_batt_apps[min_i].pwr_sum = (mw > 0) ? mw : 0;
        g_batt_apps[min_i].pwr_n = (mw > 0) ? 1 : 0;
        g_batt_apps[min_i].tmax = tmax > 0 ? tmax : 0;
        g_batt_apps[min_i].t_sum = tmax > 0 ? tmax : 0;
        g_batt_apps[min_i].t_n = tmax > 0 ? 1 : 0;
    }
}

/* 说明：v1.36.0：把一次前台 CPU 采样累加到应用条目。调用前 batt_app_add 已确保条目存在。 */
static void batt_reset_locked(int keep_hist)
{
 memset(g_batt_bucket_ms,0,sizeof(g_batt_bucket_ms));
 memset(g_batt_apps,0,sizeof(g_batt_apps));g_batt_napps=0;
 g_batt_touch_ms=g_batt_on_ms=g_batt_off_ms=g_batt_charge_ms=g_batt_run_ms=g_batt_samples=0;
 memset(g_batt_pwr_sum,0,sizeof(g_batt_pwr_sum));memset(g_batt_pwr_n,0,sizeof(g_batt_pwr_n));
 g_batt_pwr_max=0;g_batt_batt_t_sum=0;g_batt_batt_t_n=0;g_batt_batt_t_max=-1000;
 g_batt_chg_batt_t_sum=0;g_batt_chg_batt_t_n=0;g_batt_chg_batt_t_max=-1000;
 g_batt_dis_mah=g_batt_chg_mah=g_batt_dis_pwr_sum=g_batt_chg_pwr_sum=0;
 g_batt_dis_pwr_n=g_batt_chg_pwr_n=0;g_batt_cc_prev=-1;g_batt_cpu_t_max=-1000;
 if(!keep_hist){g_batt_hist_n=g_batt_hist_np=0;g_hist_last_t=g_full_at_s=g_plug_at_s=0;}
}
static void batt_hist_record_locked(double mw, double bt, double ct, int chg, int touch, int plug)
{
    if (!g_cap_probe_ok) return;
    time_t now = time(NULL);
    if (g_hist_last_t > 0 && now - g_hist_last_t < 60) return;
    long long cap = batt_read_ll(g_cap_path);
    if (cap < 0 || cap > 100) { g_hist_last_t = now; return; }

    /* 说明：前台包名 → 索引（无前台/非包名记 -1） */
    short fgi = -1;
    char pkg[256];
    pthread_mutex_lock(&g_pkg_mtx);
    safe_strncpy(pkg, g_current_pkg, sizeof(pkg));
    pthread_mutex_unlock(&g_pkg_mtx);
    if (pkg[0] && strchr(pkg, '.')) {
        for (int i = 0; i < g_batt_hist_np; i++) {
            if (strcmp(g_hist_pkgs[i], pkg) == 0) { fgi = (short)i; break; }
        }
        if (fgi < 0 && g_batt_hist_np < BATT_HIST_PKGS) {
            snprintf(g_hist_pkgs[g_batt_hist_np], sizeof(g_hist_pkgs[0]), "%s", pkg);
            fgi = (short)g_batt_hist_np;
            g_batt_hist_np++;
        }
    }

    if (g_batt_hist_n >= BATT_HIST_MAX) {
        memmove(g_batt_hist_t, g_batt_hist_t + 1, (BATT_HIST_MAX - 1) * sizeof(long long));
        memmove(g_batt_hist_cap, g_batt_hist_cap + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_fg, g_batt_hist_fg + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_scr, g_batt_hist_scr + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_chg, g_batt_hist_chg + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_touch, g_batt_hist_touch + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_plg, g_batt_hist_plg + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_net, g_batt_hist_net + 1, (BATT_HIST_MAX - 1) * sizeof(short));
        memmove(g_batt_hist_mw, g_batt_hist_mw + 1, (BATT_HIST_MAX - 1) * sizeof(float));
        memmove(g_batt_hist_bt, g_batt_hist_bt + 1, (BATT_HIST_MAX - 1) * sizeof(float));
        memmove(g_batt_hist_ct, g_batt_hist_ct + 1, (BATT_HIST_MAX - 1) * sizeof(float));
        g_batt_hist_n--;
    }
    g_batt_hist_t[g_batt_hist_n] = (long long)now;
    g_batt_hist_cap[g_batt_hist_n] = (short)cap;
    g_batt_hist_fg[g_batt_hist_n] = fgi;
    /* 说明：v1.14.0：屏幕状态入序列（UI 按此画亮屏实线/息屏虚线分段） */
    g_batt_hist_scr[g_batt_hist_n] = (short)(batt_screen_on() ? 1 : 0);
    /* 说明：v1.22.0（v14）：触摸标记。仅亮屏时有意义（息屏不会有触摸事件），
 * 故息屏统一记 -1，前端按「非亮屏」处理，避免把息屏误算成「未触摸」。
 */
    g_batt_hist_touch[g_batt_hist_n] = (short)(g_batt_hist_scr[g_batt_hist_n] == 1 ? (touch ? 1 : 0) : -1);
    /* 说明：v1.18.0（v13）：充放状态 + 记录时刻功率温度（悬浮详情/周期切分） */
    g_batt_hist_chg[g_batt_hist_n] = (short)(chg < 0 ? -1 : (chg ? 1 : 0));
    /* 说明：v1.25.0（v15）：插电标记（1/0/-1 未知）——满电插着充电器时靠它区分
 * 「已充满（电还插着）」与「放电中」，见 chg_state.h
 */
    g_batt_hist_plg[g_batt_hist_n] = (short)(plug < 0 ? -1 : (plug ? 1 : 0));
    g_batt_hist_net[g_batt_hist_n] = (short)g_batt_net;
    g_batt_hist_mw[g_batt_hist_n] = (float)(mw > 0 ? mw : 0);
    g_batt_hist_bt[g_batt_hist_n] = (float)(bt > -999.0 ? bt : 0);
    g_batt_hist_ct[g_batt_hist_n] = (float)(ct > -999.0 ? ct : 0);
    g_batt_hist_n++;
    g_hist_last_t = now;
}

/* 说明：单调时钟毫秒（v1.24.0）。取不到返回 -1，调用方跳过间隔。
 * 用 CLOCK_BOOTTIME（含休眠）而不是 time()：场景时长关心「过了多久」，不是「几点了」，
 * 系统对时/时区跳变不应影响累计。
 */
static long long batt_mono_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_BOOTTIME, &ts) != 0) return -1;
    return (long long)ts.tv_sec * 1000LL + (long long)(ts.tv_nsec / 1000000L);
}

static void batt_sample_once(void)
{

    /* 说明：网络 IO 在耗电锁外；按历史点粒度节流，不给每个 5s 样本加 dumpsys。 */
    long long net_now = batt_mono_ms();
    if (net_now < 0) g_batt_net = NET_KIND_UNKNOWN;
    else if (g_batt_net_at_ms < 0 || net_now < g_batt_net_at_ms ||
             net_now - g_batt_net_at_ms >= 60000) {
        g_batt_net = network_kind(network_read_default());
        g_batt_net_at_ms = net_now;
    }
    int on    = batt_screen_on();
    int touch = touch_is_active() && on; /* 说明：恒归亮屏侧：息屏无触摸事件，v1.6.0 起无息屏触摸桶 */
    int b     = on ? (touch ? 0 : 1) : 2;         /* 说明：桶序号见 BATT_BUCKET_COUNT 注释 */

    /* 说明：v1.36.0：本采样周期开始时的前台包名与 UID CPU 差分（用于应用算力画像）。
 * UID CPU 文件很小（本机约 150 行），在耗电锁外读取，不拉长持锁时间。
 */
    char pkg[256];
    pthread_mutex_lock(&g_pkg_mtx);
    safe_strncpy(pkg, g_current_pkg, sizeof(pkg));
    pthread_mutex_unlock(&g_pkg_mtx);
    /* 说明：v1.25.0：充放判定拆成两路——"电池在不在充入"(status) 与"充电器在不在"(online)。
 * 只按 status 判会出现实测里的问题：100% 插着充电器时 status 在
 * Charging / Discharging 之间摆动，页面显示"还在充电"，且每次摆动都被
 * 当成拔电触发一次画像重置。判读规则集中在 chg_state.h（纯函数，可单测）。
 */
    int raw_chg    = batt_charging();
    int plug       = batt_plugged();
    long long capv = g_cap_probe_ok ? batt_read_ll(g_cap_path) : -1;
    int st         = batt_chg_state(raw_chg, plug, capv);
    int chg        = batt_chg_is_charging(st);
    int dis        = batt_chg_is_discharge(st); /* 说明：v1.27.0：只有未插电放电才进放电侧统计 */

    pthread_mutex_lock(&g_batt_mtx);

    /* 说明：v1.17.0 充放周期锚点（时长双口径 + 自动重置边界）。
 * v1.25.0 修正边界判据：
 * · 插电沿 = 充电器 online 0→1（原来用 status 0→1，满电摆动时会反复触发）；
 * · 充满沿 = 电量首次到 100% 且插电（原来要求 status=Charging，
 * 而顶充结束后 status 已不是 Charging，锚点会漏记）；
 * · 重置边 = 真实拔电，或刚充满（充满即新放电周期的起点）。
 * 原来只要 status 1→0 就重置，满电插着充电器时会反复清零。
 */
    {
        time_t nowts = time(NULL);
        if (g_prev_state < 0) { /* 说明：首采样：只定基线，不触发翻转动作 */
            g_prev_state = st;
            g_prev_plug  = plug;
            g_prev_cap   = capv;
        } else {
            /* 说明：无 online 节点（plug=-1）时退回按充放状态推断，保持 v1.24.x 行为 */
            int plug_eff      = (plug >= 0) ? plug : (st != BATT_CHG_DIS ? 1 : 0);
            int prev_plug_eff = (g_prev_plug >= 0) ? g_prev_plug
                                : (g_prev_state != BATT_CHG_DIS ? 1 : 0);
            if (plug_eff && !prev_plug_eff) g_plug_at_s = (long long)nowts;
            if (st == BATT_CHG_FULL && g_prev_state != BATT_CHG_FULL) {
                if (g_prev_cap >= 0 && g_prev_cap < 100) g_full_at_s = (long long)nowts;
            }
            if (!plug_eff && prev_plug_eff) {
                batt_reset_locked(1); /* 说明：仅重置电池与全局计数，保留每日证据和基线。 */
                LOG_INFO("[耗电] 拔电进入放电周期，耗电侧累计重置");
            }
            g_prev_state = st;
            g_prev_plug  = plug;
            if (capv >= 0) g_prev_cap = capv;
        }
    }

    /* 说明：v1.24.0：场景时长改按真实经过时间累计（原实现恒记 interval*1000）。
 * 原口径的问题：interval 是「配置周期」不是「实际周期」——采样本身要读 sysfs、
 * 跑 dumpsys、算 PSI，单次 6~8s，息屏 doze 更久，于是「采一次记 5 秒」系统性少算
 * （v1.23.3 实测息屏 −38%，见 RELEASE.md 第二节）。改法：
 * · 相邻两次采样的 CLOCK_BOOTTIME 差 = 这段时间实际过了多久；
 * · 首样本没有前值，不补造时长；
 * · 差 ≤ 0（时钟异常）记 0，不倒扣；
 * · 差 > BATT_GAP_MAX_MS 视为守护停机，整段不计入（屏幕状态不可判断）；
 * · clock_gettime 失败不计时长。
 */
    long long mono_now = batt_mono_ms();
    unsigned long long add;
    if (mono_now < 0 || g_batt_last_mono_ms <= 0) {
        add = 0; /* 说明：首次或时钟读取失败时不虚构时间间隔。 */
    } else {
        long long gap = mono_now - g_batt_last_mono_ms;
        if (gap < 0 || gap > BATT_GAP_MAX_MS) gap = 0;
        add = (unsigned long long)gap;
    }
    if (mono_now >= 0) g_batt_last_mono_ms = mono_now;

    g_batt_run_ms += add;
    g_batt_samples++;
    /* 说明：v1.17.0：场景时长只累计放电侧（充放分侧），充电时长单独记。
 * v1.27.0：用 dis 而非 !chg —— 已充满/插电未充时由充电器供电，不算放电待机。
 */
    if (dis) {
        g_batt_bucket_ms[b] += add;
        if (on) g_batt_on_ms += add; else g_batt_off_ms += add;
        if (touch) g_batt_touch_ms += add;
    }
    if (chg) g_batt_charge_ms += add;

    /* 说明：温度/功耗按桶累计（v1.7.0）：读失败的项跳过，不污染均值。
 * v1.11.0 起全程功率/温度按充放电分侧累计——充电期发热与放电期口径不同不可混；
 * v1.27.0：插电未充（FULL/PLUG）也不入放电功耗统计，避免 0mW 外部供电态混进耗电均值
 */
    double mw = batt_read_power_mw();
    if (mw > 0) {
        /* 说明：v1.17.0：bucket 功率属放电侧统计，充电期只进充电分侧 */
        if (chg) { g_batt_chg_pwr_sum += mw; g_batt_chg_pwr_n++; }
        else if (dis) {
            g_batt_pwr_sum[b] += mw;
            g_batt_pwr_n[b]++;
            if (mw > g_batt_pwr_max) g_batt_pwr_max = mw;
            g_batt_dis_pwr_sum += mw;
            g_batt_dis_pwr_n++;
        }
    }
    double bt = batt_read_batt_temp_c();
    if (bt > -1000.0) {
        if (chg) {
            g_batt_chg_batt_t_sum += bt;
            g_batt_chg_batt_t_n++;
            if (bt > g_batt_chg_batt_t_max) g_batt_chg_batt_t_max = bt;
        } else if (dis) {
            g_batt_batt_t_sum += bt;
            g_batt_batt_t_n++;
            if (bt > g_batt_batt_t_max) g_batt_batt_t_max = bt;
        }
    }
    /* 说明：电量计数差分（v1.11.0）：charge_counter 增量=充入、减少=放出，µAh→mAh。
 * 首个样本只定基线；读失败（返回 0）不动基线，不产生错误差分。
 */
    if (g_cc_probe_ok) {
        long long cc = batt_read_ll(g_cc_path);
        if (cc > 0) {
            if (g_batt_cc_prev > 0) {
                long long d = cc - g_batt_cc_prev;
                if (d > 0) g_batt_chg_mah += (double)d / 1000.0;
                else if (d < 0) g_batt_dis_mah += (double)(-d) / 1000.0;
            }
            g_batt_cc_prev = cc;
        }
    }
    double ct = batt_read_cpu_temp_c();
    if (dis && ct > g_batt_cpu_t_max) g_batt_cpu_t_max = ct; /* 说明：v1.17.0/v1.27.0：结温峰值属放电侧统计 */

    if (dis && on && pkg[0] && strchr(pkg,'.'))
        batt_app_add(pkg,add,mw,bt > -999 ? bt : 0);
    /* 说明：v1.13.0：每 60s 记电量+前台时间序列（耗电统计页曲线/泳道数据源） */
    batt_hist_record_locked(mw, bt, ct, chg, touch, plug);

    pthread_mutex_unlock(&g_batt_mtx);
}

static void batt_dump_locked(void)
{
    char tpath[512];
    snprintf(tpath, sizeof(tpath), "%s.tmp", BATTERY_FILE);
    FILE *fp = fopen(tpath, "w");
    if (!fp) {
        LOG_DEBUG("[耗电] 无法写入 %s", tpath);
        return;
    }

    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);
    char ts[40];
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tmv);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 23);
    cJSON_AddStringToObject(root, "updated", ts);
    cJSON_AddNumberToObject(root, "interval_s", 5);
    cJSON_AddNumberToObject(root, "samples", (double)g_batt_samples);
    cJSON_AddNumberToObject(root, "run_ms", (double)g_batt_run_ms);
    cJSON_AddNumberToObject(root, "touch_ms", (double)g_batt_touch_ms);
    cJSON_AddNumberToObject(root, "on_ms", (double)g_batt_on_ms);
    cJSON_AddNumberToObject(root, "off_ms", (double)g_batt_off_ms);
    cJSON_AddNumberToObject(root, "charge_ms", (double)g_batt_charge_ms);

    /* 说明：屏幕/充电状态检测口径：none = 退化（恒亮屏 / 恒放电） */
    const char *scr = "none";
    if (g_screen_probe_ok) scr = (g_screen_kind == 0) ? "brightness" : "bl_power";
    cJSON_AddStringToObject(root, "screen_node", scr);
    const char *chg_node = "none";
    if (g_charge_probe_ok) chg_node = (g_charge_kind == 0) ? "status" : "online";
    cJSON_AddStringToObject(root, "charge_node", chg_node);

    /* 说明：流畅度口径（v1.8.0）：psi=压力停顿可用；stat 恒可用故不单列 */

    /* 说明：温度/功耗口径（v1.7.0，v1.10.0 起如实上报实际设备名）：power=电池功率，temp_batt=电池温度 */
    const char *pwr_node = g_pwr_probe_ok ? (g_pwr_dev[0] ? g_pwr_dev : "battery") : "none";
    cJSON_AddStringToObject(root, "power_node", pwr_node);
    const char *bt_node = g_batt_t_probe_ok ? (g_batt_t_dev[0] ? g_batt_t_dev : "battery") : "none";
    cJSON_AddStringToObject(root, "temp_batt_node", bt_node);
    cJSON_AddNumberToObject(root, "temp_cpu_zones", (double)g_thermal_n);
    cJSON_AddNumberToObject(root, "pwr_max_mw", g_batt_pwr_max);
    cJSON_AddNumberToObject(root, "batt_t_max_c", g_batt_batt_t_max > -999 ? g_batt_batt_t_max : 0);
    cJSON_AddNumberToObject(root, "cpu_t_max_c", g_batt_cpu_t_max > -999 ? g_batt_cpu_t_max : 0);
    cJSON_AddNumberToObject(root, "batt_t_avg_c",
                            g_batt_batt_t_n ? g_batt_batt_t_sum / (double)g_batt_batt_t_n : 0);
    cJSON_AddNumberToObject(root, "batt_t_n", (double)g_batt_batt_t_n);
    /* 说明：v1.11.0（v8）：充放电分侧统计——放电期=耗电统计，充电期=充电统计，口径分离。
 * avg+n 模式与既有字段一致，restore 按 sum=avg*n 回填
 */
    cJSON_AddNumberToObject(root, "dis_mah", g_batt_dis_mah);
    cJSON_AddNumberToObject(root, "chg_mah", g_batt_chg_mah);
    cJSON_AddNumberToObject(root, "dis_avg_mw",
                            g_batt_dis_pwr_n ? g_batt_dis_pwr_sum / (double)g_batt_dis_pwr_n : 0);
    cJSON_AddNumberToObject(root, "dis_pwr_n", (double)g_batt_dis_pwr_n);
    cJSON_AddNumberToObject(root, "chg_avg_mw",
                            g_batt_chg_pwr_n ? g_batt_chg_pwr_sum / (double)g_batt_chg_pwr_n : 0);
    cJSON_AddNumberToObject(root, "chg_pwr_n", (double)g_batt_chg_pwr_n);
    cJSON_AddNumberToObject(root, "dis_ms",
                            (double)(g_batt_run_ms > g_batt_charge_ms ? g_batt_run_ms - g_batt_charge_ms : 0));
    cJSON_AddNumberToObject(root, "chg_ms", (double)g_batt_charge_ms);
    cJSON_AddNumberToObject(root, "chg_t_avg_c",
                            g_batt_chg_batt_t_n ? g_batt_chg_batt_t_sum / (double)g_batt_chg_batt_t_n : 0);
    cJSON_AddNumberToObject(root, "chg_t_n", (double)g_batt_chg_batt_t_n);
    cJSON_AddNumberToObject(root, "chg_t_max_c", g_batt_chg_batt_t_max > -999 ? g_batt_chg_batt_t_max : 0);
    cJSON_AddStringToObject(root, "cc_node", g_cc_probe_ok ? "charge_counter" : "none");
    /* 说明：v1.25.0（dump v15）：充电器在不在（plugged）与充放状态（chg_state）如实上报。
 * chg_state：0=放电 1=充电中 2=已充满（插电且电量到顶）3=插电未充电。
 * 满电插着充电器时是 2 而不是 1——这是本次修复的核心字段
 * （旧版只能按 pwr_now_mw 的正负猜，100% 时电流接近 0，正负本身就不可靠）。
 */
    int dplug = batt_plugged();
    long long dcap = g_cap_probe_ok ? batt_read_ll(g_cap_path) : -1;
    int dst = batt_chg_state(batt_charging(), dplug, dcap);
    cJSON_AddNumberToObject(root, "plugged", (double)dplug);
    cJSON_AddNumberToObject(root, "chg_state", (double)dst);
    {
        char plugnode[192] = {0};
        for (int i = 0; i < g_plug_n; i++) {
            size_t used = strlen(plugnode);
            if (used) strncat(plugnode, ",", sizeof(plugnode) - used - 1);
            used = strlen(plugnode);
            strncat(plugnode, g_plug_devs[i], sizeof(plugnode) - used - 1);
        }
        cJSON_AddStringToObject(root, "plug_node", g_plug_n ? plugnode : "none");
    }
    /* 说明：v1.10.0：dump 瞬时的电池温度/结温（UI 显示"当前"，避免均值被误读为实时值） */
    {
        double btc = batt_read_batt_temp_c();
        cJSON_AddNumberToObject(root, "batt_t_cur_c", btc > -999 ? btc : 0);
        double ctc = batt_read_cpu_temp_c();
        cJSON_AddNumberToObject(root, "cpu_t_cur_c", ctc > -999 ? ctc : 0);
        /* 说明：v1.17.0：瞬时整机功率带符号（充电正 / 放电负），UI 实时功率卡数据源。
 * v1.25.0：正负按 chg_state 判（只有"充电中"算正），不再直接调 batt_charging()——
 * 满电插电时那是 0，会把"已充满"错画成"放电中"。
 */
        double nowmw = batt_read_power_mw();
        cJSON_AddNumberToObject(root, "pwr_now_mw",
                                nowmw > 0 ? (dst == BATT_CHG_CHG ? nowmw : -nowmw) : 0);
    }
    /* 说明：v1.17.0：充放周期锚点（已使用时长双口径）——unix 秒，0=尚无记录 */
    cJSON_AddNumberToObject(root, "full_at_s", (double)g_full_at_s);
    cJSON_AddNumberToObject(root, "plug_at_s", (double)g_plug_at_s);

    /* 说明：每桶平均功率（mW）：能效比判断的核心——同场景均频对比配合 mW 对比 */
    cJSON *pwr = cJSON_AddObjectToObject(root, "bucket_pwr_mw");
    for (int b = 0; b < BATT_BUCKET_COUNT; b++) {
        cJSON *bo = cJSON_CreateObject();
        cJSON_AddNumberToObject(bo, "avg", g_batt_pwr_n[b] ? g_batt_pwr_sum[b] / (double)g_batt_pwr_n[b] : 0);
        cJSON_AddNumberToObject(bo, "n", (double)g_batt_pwr_n[b]);
        cJSON_AddItemToObject(pwr, g_bucket_names[b], bo);
    }

    /* 说明：场景时长（毫秒，wall time；v1.6.0 起三桶：on_touch/on_idle/off） */
    cJSON *bms = cJSON_AddObjectToObject(root, "bucket_ms");
    for (int b = 0; b < BATT_BUCKET_COUNT; b++)
        cJSON_AddNumberToObject(bms, g_bucket_names[b], (double)g_batt_bucket_ms[b]);

    /* 说明：应用按占用降序（插入排序下标） */
    int order[BATT_MAX_APPS];
    int n = g_batt_napps;
    for (int i = 0; i < n; i++) order[i] = i;
    for (int i = 1; i < n; i++) {
        int k = order[i], j = i - 1;
        while (j >= 0 && g_batt_apps[order[j]].ms < g_batt_apps[k].ms) {
            order[j + 1] = order[j];
            j--;
        }
        order[j + 1] = k;
    }
    cJSON *apps = cJSON_AddArrayToObject(root, "apps");
    for (int i = 0; i < n; i++) {
        BattApp *ap = &g_batt_apps[order[i]];
        cJSON *a = cJSON_CreateObject();
        cJSON_AddStringToObject(a, "pkg", ap->pkg);
        cJSON_AddNumberToObject(a, "ms", (double)ap->ms);
        /* 说明：前台期间整机平均功率（mW）+ 样本数（v1.9.0，pwn=0 表示无功率样本） */
        cJSON_AddNumberToObject(a, "pw", ap->pwr_n ?
                                ap->pwr_sum / (double)ap->pwr_n : 0);
        cJSON_AddNumberToObject(a, "pwn", (double)ap->pwr_n);
        /* 说明：v1.10.0：前台期间 SoC 结温峰值（0=无温度样本） */
        cJSON_AddNumberToObject(a, "tmax", ap->tmax);
        /* 说明：v1.14.0：前台期间电池温度平均值（t_n=0 时为 0，UI 显示 —） */
        cJSON_AddNumberToObject(a, "tavg", ap->t_n ?
                                ap->t_sum / (double)ap->t_n : 0);
        cJSON_AddItemToArray(apps, a);
    }

    /* 说明：v1.13.0（v10）→ v1.14.0（v11）：电量+前台时间序列（耗电统计页）。
 * hist_pkgs=泳道包名表（索引稳定）；hist 为四元组 [unix秒, 电量%, 前台索引, 屏幕状态]，
 * 前台索引 -1=无前台、屏幕 1=亮屏/0=息屏/-1=未知。点数 ≤1500（60s 一针 ≈25h 窗口）。
 * v1.18.0（v13）扩为八元组：+充放状态(1充/0放/-1未知)、+功率mW、+电池温度°C、+结温°C。
 */
    cJSON *hp = cJSON_AddArrayToObject(root, "hist_pkgs");
    for (int i = 0; i < g_batt_hist_np; i++)
        cJSON_AddItemToArray(hp, cJSON_CreateString(g_hist_pkgs[i]));
    cJSON *hist = cJSON_AddArrayToObject(root, "hist");
    for (int i = 0; i < g_batt_hist_n; i++) {
        cJSON *pt = cJSON_CreateArray();
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_t[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_cap[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_fg[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_scr[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_chg[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_mw[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_bt[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_ct[i]));
        /* 说明：v1.22.0（v14）第 9 位：触摸标记 1/0/-1（息屏） */
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_touch[i]));
        /* 说明：v1.25.0（v15）第 10 位：插电标记 1/0/-1（未知） */
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_plg[i]));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)g_batt_hist_net[i]));
        cJSON_AddItemToArray(hist, pt);
    }
    /* 说明：电池总容量（µAh，charge_full 探测失败=0）与 capacity 节点可用性 */
    cJSON_AddNumberToObject(root, "batt_full_ua", (double)g_batt_full_ua);
    cJSON_AddStringToObject(root, "cap_node", g_cap_probe_ok ? "capacity" : "none");

    char *out = cJSON_PrintUnformatted(root);
    int saved = 0;
    if (out) {
        saved = fputs(out, fp) >= 0 && fflush(fp) == 0 && !ferror(fp);
        free(out);
    }
    cJSON_Delete(root);
    if (fclose(fp) != 0) saved = 0;
    if (saved) {
        if (rename(tpath, BATTERY_FILE) != 0) unlink(tpath);
    } else unlink(tpath);
}

static void batt_restore_from_file(void)
{
    FILE *fp = fopen(BATTERY_FILE, "r");
    if (!fp) return;
    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (sz <= 0 || sz > 16 * 1024 * 1024) { fclose(fp); return; }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(fp); return; }
    size_t rd = fread(buf, 1, (size_t)sz, fp);
    fclose(fp);
    buf[rd] = '\0';
    cJSON *root = rd == (size_t)sz ? cJSON_ParseWithOpts(buf,NULL,1) : NULL;
    free(buf);
    if (!cJSON_IsObject(root)) { cJSON_Delete(root); return; }

    pthread_mutex_lock(&g_batt_mtx);

    cJSON *n = cJSON_GetObjectItem(root, "run_ms");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_run_ms = (unsigned long long)n->valuedouble;
    /* 说明：v1.17.0：充放锚点恢复（旧版无键保持 0=尚无记录）；充电状态基线置 -1，
 * 重启后首采样只定基线，不把恢复的画像误判为周期翻转而清零
 */
    n = cJSON_GetObjectItem(root, "full_at_s");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_full_at_s = (long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "plug_at_s");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_plug_at_s = (long long)n->valuedouble;
    g_prev_state = -1;
    g_prev_plug = -1;
    g_prev_cap = -1;
    n = cJSON_GetObjectItem(root, "version");
    int batt_ver = cJSON_IsNumber(n) ? n->valueint : 5;
    n = cJSON_GetObjectItem(root, "samples");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_samples = (unsigned long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "touch_ms");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_touch_ms = (unsigned long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "on_ms");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_on_ms = (unsigned long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "off_ms");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_off_ms = (unsigned long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "charge_ms");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_charge_ms = (unsigned long long)n->valuedouble;
    n = cJSON_GetObjectItem(root, "pwr_max_mw");
    if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_pwr_max = n->valuedouble;
    n = cJSON_GetObjectItem(root, "batt_t_max_c");
    if (cJSON_IsNumber(n) && n->valuedouble > -999) g_batt_batt_t_max = n->valuedouble;
    /* 说明：结温峰值：v7 起才排除了 hw-trip 等非测温 zone，旧值（恒 95°C）不可信，不回填 */
    n = cJSON_GetObjectItem(root, "cpu_t_max_c");
    if (batt_ver >= 7 && cJSON_IsNumber(n) && n->valuedouble > -999)
        g_batt_cpu_t_max = n->valuedouble;
    n = cJSON_GetObjectItem(root, "batt_t_avg_c");
    double bt_avg = cJSON_IsNumber(n) ? n->valuedouble : 0;
    n = cJSON_GetObjectItem(root, "batt_t_n");
    if (cJSON_IsNumber(n) && n->valuedouble > 0) {
        g_batt_batt_t_n = (unsigned long long)n->valuedouble;
        g_batt_batt_t_sum = bt_avg * (double)g_batt_batt_t_n;
    }
    /* 说明：v1.11.0（v8）：充放电分侧统计回填；旧版无这些键保持 0/基线，不影响其他恢复。
 * dis_ms/chg_ms 不回填——由 run_ms/charge_ms 推出
 */
    if (batt_ver >= 8) {
        n = cJSON_GetObjectItem(root, "dis_mah");
        if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_dis_mah = n->valuedouble;
        n = cJSON_GetObjectItem(root, "chg_mah");
        if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_chg_mah = n->valuedouble;
        n = cJSON_GetObjectItem(root, "dis_avg_mw");
        double dav = cJSON_IsNumber(n) ? n->valuedouble : 0;
        n = cJSON_GetObjectItem(root, "dis_pwr_n");
        if (cJSON_IsNumber(n) && n->valuedouble > 0) {
            g_batt_dis_pwr_n = (long long)n->valuedouble;
            g_batt_dis_pwr_sum = dav * (double)g_batt_dis_pwr_n;
        }
        n = cJSON_GetObjectItem(root, "chg_avg_mw");
        double cav = cJSON_IsNumber(n) ? n->valuedouble : 0;
        n = cJSON_GetObjectItem(root, "chg_pwr_n");
        if (cJSON_IsNumber(n) && n->valuedouble > 0) {
            g_batt_chg_pwr_n = (long long)n->valuedouble;
            g_batt_chg_pwr_sum = cav * (double)g_batt_chg_pwr_n;
        }
        n = cJSON_GetObjectItem(root, "chg_t_max_c");
        if (cJSON_IsNumber(n) && n->valuedouble > -999) g_batt_chg_batt_t_max = n->valuedouble;
        n = cJSON_GetObjectItem(root, "chg_t_avg_c");
        double ct_avg = cJSON_IsNumber(n) ? n->valuedouble : 0;
        n = cJSON_GetObjectItem(root, "chg_t_n");
        if (cJSON_IsNumber(n) && n->valuedouble > 0) {
            g_batt_chg_batt_t_n = (long long)n->valuedouble;
            g_batt_chg_batt_t_sum = ct_avg * (double)g_batt_chg_batt_t_n;
        }
    }
    cJSON *bpw = cJSON_GetObjectItem(root, "bucket_pwr_mw");
    if (cJSON_IsObject(bpw)) {
        for (int b = 0; b < BATT_BUCKET_COUNT; b++) {
            cJSON *bo = cJSON_GetObjectItem(bpw, g_bucket_names[b]);
            if (!cJSON_IsObject(bo)) continue;
            cJSON *av = cJSON_GetObjectItem(bo, "avg");
            cJSON *nn = cJSON_GetObjectItem(bo, "n");
            if (cJSON_IsNumber(av) && cJSON_IsNumber(nn) && nn->valuedouble > 0) {
                g_batt_pwr_n[b] = (unsigned long long)nn->valuedouble;
                g_batt_pwr_sum[b] = av->valuedouble * (double)g_batt_pwr_n[b];
            }
        }
    }

    cJSON *bms = cJSON_GetObjectItem(root, "bucket_ms");
    if (cJSON_IsObject(bms)) {
        for (int b = 0; b < BATT_BUCKET_COUNT; b++) {
            n = cJSON_GetObjectItem(bms, g_bucket_names[b]);
            if (!cJSON_IsNumber(n) && b == 2) /* 说明：v1.5.0 旧键 off_idle 并入 off */
                n = cJSON_GetObjectItem(bms, "off_idle");
            if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_bucket_ms[b] = (unsigned long long)n->valuedouble;
        }
    }

    cJSON *apps = cJSON_GetObjectItem(root, "apps");
    if (cJSON_IsArray(apps)) {
        cJSON *it;
        cJSON_ArrayForEach(it, apps) {
            cJSON *pk = cJSON_GetObjectItem(it, "pkg");
            cJSON *ms = cJSON_GetObjectItem(it, "ms");
            if (cJSON_IsString(pk) && cJSON_IsNumber(ms) && ms->valuedouble > 0) {
/* 说明：v1.11.0（v9）：apps[].tmax 语义改为电池温度峰值，旧版（≤v8）为结温语义不回填 */
                cJSON *tm = cJSON_GetObjectItem(it, "tmax");
                double tmax_v = (batt_ver >= 9 && cJSON_IsNumber(tm) && tm->valuedouble > 0) ? tm->valuedouble : 0;
                batt_app_add(pk->valuestring, (unsigned long long)ms->valuedouble, 0, tmax_v);
                /* 说明：v1.9.0 功率回填：pw=平均 mW、pwn=样本数，直接覆盖新增项的 0 值 */
                cJSON *pwn = cJSON_GetObjectItem(it, "pwn");
                cJSON *pw  = cJSON_GetObjectItem(it, "pw");
                if (cJSON_IsNumber(pwn) && pwn->valuedouble > 0 && cJSON_IsNumber(pw)) {
                    for (int i = 0; i < g_batt_napps; i++) {
                        if (strcmp(g_batt_apps[i].pkg, pk->valuestring) == 0) {
                            g_batt_apps[i].pwr_n = (unsigned long long)pwn->valuedouble;
                            g_batt_apps[i].pwr_sum = pw->valuedouble * (double)g_batt_apps[i].pwr_n;
                            break;
                        }
                    }
                }
                /* 说明：v1.14.0 平均温度回填：tavg×tmax 的样本权重建 t_sum/t_n（沿用 pwn 样本数作权重） */
                cJSON *tav = cJSON_GetObjectItem(it, "tavg");
                if (cJSON_IsNumber(tav) && tav->valuedouble > 0 &&
                    cJSON_IsNumber(pwn) && pwn->valuedouble > 0) {
                    for (int i = 0; i < g_batt_napps; i++) {
                        if (strcmp(g_batt_apps[i].pkg, pk->valuestring) == 0) {
                            g_batt_apps[i].t_n = (unsigned long long)pwn->valuedouble;
                            g_batt_apps[i].t_sum = tav->valuedouble * (double)g_batt_apps[i].t_n;
                            break;
                        }
                    }
                }
                /* 说明：v1.36.0（dump v17）：应用前台 CPU 详细统计回填；旧版无这些键保持 0。
 * dump 里 load_avg/freq_avg 是均值，恢复时按 avg×n 还原累计和。
 */
            }
        }
    }

    /* 说明：v1.13.0（v10）：电量+前台时间序列回填。旧版无这些键保持空，不影响其他恢复。
 * v10=三元组 [unix秒, 电量%, 前台索引]；v11=四元组追加屏幕状态（1亮/0息/-1未知）。
 */
    if (batt_ver >= 10) {
        cJSON *hpk = cJSON_GetObjectItem(root, "hist_pkgs");
        if (cJSON_IsArray(hpk)) {
            cJSON *it;
            int i = 0;
            cJSON_ArrayForEach(it, hpk) {
                if (i >= BATT_HIST_PKGS) break;
                if (cJSON_IsString(it)) {
                    snprintf(g_hist_pkgs[i], sizeof(g_hist_pkgs[0]), "%s", it->valuestring);
                    i++;
                }
            }
            g_batt_hist_np = i;
        }
        cJSON *hs = cJSON_GetObjectItem(root, "hist");
        if (cJSON_IsArray(hs)) {
            cJSON *it;
            int i = 0;
            cJSON_ArrayForEach(it, hs) {
                if (i >= BATT_HIST_MAX) break;
                if (!cJSON_IsArray(it)) continue;
                cJSON *a = it->child, *b = a ? a->next : NULL, *c = b ? b->next : NULL;
                cJSON *d = c ? c->next : NULL;
                if (a && b && c && cJSON_IsNumber(a) && cJSON_IsNumber(b) && cJSON_IsNumber(c)) {
                    g_batt_hist_t[i] = (long long)a->valuedouble;
                    g_batt_hist_cap[i] = (short)b->valuedouble;
                    g_batt_hist_fg[i] = (short)c->valuedouble;
                    /* 说明：v11 第4元素=屏幕状态；v10 旧数据无此元素记 -1（UI 按未知画实线） */
                    g_batt_hist_scr[i] = (d && cJSON_IsNumber(d)) ? (short)d->valuedouble : -1;
                    /* 说明：v13 第5-8元素=充放/功率/温度；旧数据记默认（chg=-1, mw/bt/ct=0） */
                    cJSON *e = d ? d->next : NULL;
                    g_batt_hist_chg[i] = (e && cJSON_IsNumber(e)) ? (short)e->valuedouble : -1;
                    e = e ? e->next : NULL;
                    g_batt_hist_mw[i] = (e && cJSON_IsNumber(e)) ? (float)e->valuedouble : 0;
                    e = e ? e->next : NULL;
                    g_batt_hist_bt[i] = (e && cJSON_IsNumber(e)) ? (float)e->valuedouble : 0;
                    e = e ? e->next : NULL;
                    g_batt_hist_ct[i] = (e && cJSON_IsNumber(e)) ? (float)e->valuedouble : 0;
                    /* 说明：v14 第9元素=触摸标记；v13 及更早无此元素，记 -1（未知） */
                    e = e ? e->next : NULL;
                    g_batt_hist_touch[i] = (e && cJSON_IsNumber(e)) ? (short)e->valuedouble : -1;
                    /* 说明：v15 第10元素=插电标记；v14 及更早无此元素，记 -1（未知）
 * ——前端据此退回"只看充放状态"的旧判读，不猜插电
 */
                    e = e ? e->next : NULL;
                    g_batt_hist_plg[i] = (e && cJSON_IsNumber(e)) ? (short)e->valuedouble : -1;
                    /* 说明：v16 兼容：缺失、越界、小数均不伪造网络类型。 */
                    e = cJSON_GetArrayItem(it, 10);
                    g_batt_hist_net[i] = cJSON_IsNumber(e) ? (short)network_restore(e->valuedouble) : NET_KIND_UNKNOWN;
                    i++;
                }
            }
            g_batt_hist_n = i;
            if (i > 0) g_hist_last_t = g_batt_hist_t[i - 1];
        }
        n = cJSON_GetObjectItem(root, "batt_full_ua");
        if (cJSON_IsNumber(n) && isfinite(n->valuedouble) && n->valuedouble >= 0 && n->valuedouble < 9e15) g_batt_full_ua = (long long)n->valuedouble;
    }

    pthread_mutex_unlock(&g_batt_mtx);
    cJSON_Delete(root);
}

void *battery_worker(void *arg)
{
 (void)arg;
 batt_probe_screen();batt_probe_charge();batt_probe_plug();batt_probe_power();batt_probe_thermal();
 batt_restore_from_file();
 LOG_INFO("[耗电] 独立耗电采样启动：5秒采样/60秒历史及落盘");
 long long dumped=0;
 while(atomic_load(&g_running)) {
  batt_sample_once();
  status_battery_tick();
  long long now=batt_mono_ms();
  if(!dumped || now-dumped>=60000) {pthread_mutex_lock(&g_batt_mtx);batt_dump_locked();pthread_mutex_unlock(&g_batt_mtx);dumped=now;}
  for(int i=0;i<10 && atomic_load(&g_running);i++)usleep(500000);
 }
 pthread_mutex_lock(&g_batt_mtx);batt_dump_locked();pthread_mutex_unlock(&g_batt_mtx);
 return NULL;
}
