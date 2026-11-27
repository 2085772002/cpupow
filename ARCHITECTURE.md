# 架构说明

cpupow 是一个「感知 → 决策 → 执行」的闭环。C 守护进程按数据流分成三个区域：

```
                     ┌─────────────────────────────────────────┐
                     │             app/ 编排层（主循环）          │
                     │   事件源装配、生命周期、三层调度串联        │
                     └──────────┬──────────────┬───────────────┘
                                │              │
              ┌─────────────────▼──┐   ┌───────▼──────────────────┐
              │  collect/ 数据采集  │   │  compute/ 数据计算        │
              │ 读 sysfs / 触摸 /  │   │ 模式判定 / 触摸相位 /     │
              │ 前台 / 网络 / 电池  │   │ 策略编译 / 规则匹配       │
              └─────────────────┬──┘   └───────┬──────────────────┘
                                │              │
                                ▼              ▼
              ┌─────────────────────────────────────────────────┐
              │        output/ 数据输出                           │
              │  写 sysfs 下发调频 / 状态 JSON / 分级日志          │
              └─────────────────────────────────────────────────┘
                                │
              ┌─────────────────▼────────────────────────────────┐
              │        core/ 公共内核 + deps/ 第三方              │
              └──────────────────────────────────────────────────┘
```

## 数据采集区域（collect/）

只读系统事实，不做业务判断。

| 文件 | 职责 |
|---|---|
| `sysfs_reader` 部分 | 探测并读取 sysfs 节点（CPU 频率等） |
| `touch.c` | 定位触摸设备、监听 BTN_TOUCH 事件、断线重连，发布 `TouchSample` |
| `foreground.c` | `dumpsys window displays` 解析当前前台包名 |
| `network.c` | 解析 Android 默认网络事实（不探测公网） |
| `network_kind.h` | 网络事实 → 稳定枚举（纯函数） |
| `manualmode.c` | 读 `manual_mode.txt` 手动模式 |
| `battery.c` | 电池/耗电独立采样（5 秒采样、60 秒历史落盘），充放状态判读 |
| `chg_state.h` | 充放状态纯函数（充电/放电/已充满/插电未充电） |

## 数据计算区域（compute/）

纯逻辑，不直接碰硬件 IO。

| 文件 | 职责 |
|---|---|
| `mode.c` | 把「当前前台是谁」翻译成「用哪个调度模式」 |
| `touch_policy.c` | 触摸时序状态机（短按/长按/松手过渡/恢复） |
| `config.c` | 解析 `cpu_policy.json`、展开 sysfs 模板、编译策略树（模式 × 频率区域 × 触摸阶段） |
| `zone.c` | 频率分段与 boost 曲线公式（纯函数） |
| `pkgrules.c` | `pkg_rules.json` 规则表与包名匹配 |

## 数据输出区域（output/）

把计算结果落到系统或持久化。

| 文件 | 职责 |
|---|---|
| `sysfs.c` | 唯一预设写入器：按优先级写 sysfs、读回校验收敛、成对调上下限 |
| `status.c` | 运行心跳快照（`runtime_status.json` / `policy_status.json`） |
| `log.c` | 分级日志（级别过滤、跨小时重开、5MB 轮转、线程安全） |

## 编排层（app/）

| 文件 | 职责 |
|---|---|
| `main.c` | 进程生命周期、inotify/epoll 事件源装配、主循环状态机 |
| `probe.c` | 前台探测线程（串行化阻塞的 dumpsys 调用） |

## 公共内核（core/）

跨层共享、无业务语义。

| 文件 | 职责 |
|---|---|
| `state.c/.h` | 进程级共享状态（`g_running`/`g_current_mode`/`g_current_pkg` 等）单一所有权 |
| `util.c/.h` | 字符串安全操作 |
| `instance.c/.h` | 守护进程单实例锁（flock + /proc 身份校验 + 每 5 秒核对锁文件 inode） |
| `clock.h` | 单调时钟 / 开机时钟工具 |

## 配置结构（author-touch-3，v2.5.5 起）

```
global.zones                    三个区域的边界（一份，物理分段）
  enabled                        boost 是否写入
  sample_ms                      公用采样间隔（区域判定 / 限最大频 / boost / 频率展示共用，缺省 10ms）
  clusters{核组:{linear_end,decay_end}}
global.maxfreq                  动态限最大频总开关（v2.5.8；缺省视为开启）
  enabled
（每模式的顶住时长）              presets[模式].maxfreq{decay_hold_ms,saturate_hold_ms}（v2.5.11）

presets[模式]                    四档：powersave / balance / performance / fast
  touch                         该模式的触摸时序（long_press_ms / release_delay_ms）
  zones[区域]                    linear / decay / saturate
    boost{核组:{bend,start,end}} 该模式该区的动态 boost 公式
    "*" + touch_down/long/up     该区的策略块（常规基础必填，触摸增量可选）

defaults                        所有模式的公共基线，先应用再被各层覆盖
```

运行时按**每个核组当前频率所在的区域**取对应那一套节点下发：

- `config_set_cluster_zone()` 记录采集侧算出的区域，`config_apply_phase_for()`
  据此把各核组的节点融合成一次下发（非核组节点只取线性区那一份）。
- 区域切换有迟滞：看最近 8 次采样（`compute/zone_window.c`），某区占到 2/3 才提交，
  且同一核组两次切换间隔 ≥1 秒；切换后按已下发阶段重下发。
  这样写下去的 `min_freq` 改变频率、频率又决定区域时不会来回震荡。
- `zones.enabled=false` 只停止写 boost，不改变区域判定与按区分发的策略。

### 动态限最大频（compute/cap.c）

两条分界线同时是最大频的档位上限：0 档 `linear_end`、1 档 `decay_end`、2 档硬件最高频。
默认停在 0 档；持续顶住当前上限满设定时长才升一档（防毛刺）；
回落到上一档上限的 90% 以下并持续 500ms 才降一档（防误降）。两次换档最小间隔 100ms。
开启时策略树不再写 `scaling_max_freq`（编译期过滤），该节点由运行时限频器独占；
当前上限通过 `runtime_status.json` 的 `caps` 字段发布。
两个「顶住时长」按模式各自配置（v2.5.11），旧配置写在 `global.maxfreq` 里的时长作为兜底。
顶住判定用的是「请求值与内核实际接受值里更小的那个」（v2.5.13）——内核会把非真实频点向下取整，
拿请求值比会永远差一点、永远不解锁。
分界线由生成器吸附到真实频点——写一个频率表里没有的值会被内核向下取整。

## 常态开销（v2.5.6 起）

主循环是事件驱动的：触摸、前台切换、inotify 改动都会立刻唤醒；没有事件时按空闲程度退避。

- **等待**：有触摸在进行时 100ms 一轮；3 秒无输入 300ms；30 秒无输入 1000ms。
- **频率采样**：`cpuinfo_min/max` 是硬件静态属性，缓存 60 秒；每次采样只读 `scaling_cur_freq`。
- **写节点去重**：`output/sysfs.c` 记住每个节点最近一次的请求值，值没变就不碰 sysfs；
  每 5 分钟全量重写一次，让被 PM QoS / 温控 / PowerHAL 改过的节点自愈。
  配置热重载时缓存作废。boost 仍按「值变才写 + 每 2 秒强制重写」独立处理。
- **状态落盘**：`runtime_status.json` 2 秒限频；`policy_status.json` 2 秒限频 + 退出强制刷新。

调优时优先看 `[perf]` 行：`loop avg`（每轮处理耗时）、`write ok/skip`、`freq sample`。

## 单实例与升级

模块升级会整体替换目录，锁文件换 inode，旧实例的 flock 落在已删除的文件上——
新实例能重新拿到锁，于是两个守护进程同时写 sysfs（v2.5.8 之前的真机日志里出现过）。

- 守护进程每 5 秒比对 `fstat(锁 fd)` 与 `stat(锁文件路径)` 的 inode/设备号，
  不一致就按 E 级日志告警、干净退出（且不回写触摸基线）。
- `customize.sh` 在改动文件前按 `/proc/*/exe` 扫描并清掉残留守护进程（只处理无参数的进程本体）。

## 依赖方向与约束

- 依赖只能 `app → collect/compute/output → core → deps`
- `collect` 只读系统，不做业务标签；`compute` 纯逻辑零 IO；`output` 只写不判断
- 跨模块共享全局收敛在 `core/state.c`，禁止各模块私自定义
- sysfs 写入由 `output/sysfs.c` 唯一承担，其它模块不得直接 open sysfs 写

## dump 兼容性

`battery.c` 落盘的 `profile_battery.json` 字段名（`hist`/`samples`/`apps`/`bucket_ms` 等）
由 `module/webroot` 前端依赖。重构只改 C 侧内部标识符，**不改任何 dump 字段名**。

## WebUI（module/webroot）

前端是静态资源，设备上不跑打包器：`index.html` 直接按顺序加载 `js/` 下的脚本，
样式是构建期生成的 `css/app.css`。

| 位置 | 职责 |
|---|---|
| `index.html` | 主题引导（`html.dark` + `color-scheme`）、错误分级上报、脚本装配 |
| `js/common/core.js` | `KsuService`（同步桥接的 Promise 封装）、页面作用域 `createPageScope`、图标/应用名解析队列 |
| `js/common/ui.js` | 图标组件、`AppIcon`、模式常量、Tooltip |
| `js/app.js` | 路由壳、启动与预热策略、底部导航 |
| `js/views/*` | 五个页面：状态 / 耗电 / 应用 / 配置 / 日志 |

### 启动与预热

1. 路由壳先挂载，启动页盖住整屏。
2. 只有**当前可见页**（状态页）参与启动判断：首载完成即收起启动页，硬兜底 1.2 秒。
3. 启动页收起后按 `WARM_ORDER`（配置 → 日志 → 应用 → 耗电）**逐页**预热，
   一次只挂一页；本页首载完成或超出 `route.warmMs`（普通页 3 秒、耗电页 9 秒）就推进。
4. 预热期只做「便宜」的读取：不提交图标提取（`IconTool` 每批 fork 一次 app_process64）、
   不读设备频率（`cpu_info.sh` 遍历上百个 sysfs 节点）。两者在用户真正进入对应页面时才做。

约束：`window.ksu.exec` 是同步 JavaScriptInterface，每条命令都会占住 JS 主线程。
任何新增的设备读取都必须挂在 `usePageTask` 下（它在页面不活跃时跳过、切换时取消、
执行前等一次绘制），不要在渲染路径或事件回调里直接调 `exec`。
