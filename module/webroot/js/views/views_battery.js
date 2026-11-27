/* 说明：views_battery.js — 耗电统计页（v1.13.0 起，参考 Scene 耗电统计）
 * 数据：profile.json 的 hist 时间序列（≥60s/针，dump v16 十一元组（兼容旧记录））+ 累计统计。
 * 结构：电量/温度曲线 → 实时三卡 → 平均功耗（含平均耗电时长/整机亮屏/整机平均/曲线/息屏明细）
 * → 理论续航（五口径区间）→ 充电统计（默认只展示充入电量/充电时长）→ 应用耗电排行。
 * v1.35.0：充电曲线叠加充电百分比线（右轴 0~100%）；充电时自动置顶弹出，其他卡保持默认收起。
 * 选中充电曲线采样点时在图内悬浮显示详情，不在图上常驻或在图下堆叠单点数值。
 */
(function (CP) {
    'use strict';
    var h = CP.h;
    var KsuService = CP.KsuService;
    var Icon = CP.Icon;
    var AppIcon = CP.AppIcon;
    var NameResolver = CP.NameResolver;
    var PROFILE_PATH = CP.MODULE_DIR + '/profile.json';
    /* 说明：v1.21.4：被删除（本地隐藏）的放电周期记录。一行一个周期起点时间戳（unix 秒），
 * 逗号分隔。守护进程的 hist 是环形缓冲，无法从 C 侧删单段，所以"删除周期"
 * 落在前端可见性上：记录起点时间戳后，渲染时过滤掉，并提供"恢复已删除"。
 */
    var HIDDEN_PATH = CP.MODULE_DIR + '/cycle_hidden.txt';

    var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo, useRef = React.useRef;
    var POINT_HIDE_MS = 300;

    function fmtDur(ms) {
        if (!ms || ms < 1000) return '0 秒';
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + ' 秒';
        var m = Math.floor(s / 60); s = s % 60;
        if (m < 60) return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
        var hh = Math.floor(m / 60); m = m % 60;
        if (hh < 24) return hh + ' 小时' + (m ? ' ' + m + ' 分' : '');
        var d = Math.floor(hh / 24); hh = hh % 24;
        return d + ' 天' + (hh ? ' ' + hh + ' 小时' : '');
    }
    /* 说明：单个时长文本（区间退化成一个值时用）：与 fmtRange 同精度 */
    var fmtHours = function (hh) {
        if (!(hh > 0)) return '—';
        return hh >= 100 ? (hh / 24).toFixed(1) + ' 天' : hh.toFixed(1) + ' 小时';
    };
    /* 说明：续航区间文本（v1.23.2）：两端共用单位，只写一次（「5.2~12.4 小时」），
 * 比「5.2 小时~12.4 小时」短一半——卡片一行放得下，也不用缩字号。
 * ≥100h 换成天（息屏档满电时能到 40h+，再往上按小时写就三位数了）。
 */
    var fmtRange = function (lo, hi) {
        if (!(lo > 0) || !(hi > 0)) return '—';
        if (hi >= 100) return (lo / 24).toFixed(1) + '~' + (hi / 24).toFixed(1) + ' 天';
        return lo.toFixed(1) + '~' + hi.toFixed(1) + ' 小时';
    };
    var fmtW = function (mw) {
        /* 说明：v1.23.1：原实现 <100 mW 一律显「<0.1 W」、100~149 mW 显「0.1 W」，
 * 息屏段的 90~140 mW 会被压成同一个数，看着像「全是 0.1 W」。
 * 现 <100 mW 直接显 mW，其余保留两位小数（10 mW 精度）。
 */
        if (!(mw > 0)) return '—';
        return mw >= 100 ? (mw / 1000).toFixed(2) + ' W' : Math.round(mw) + ' mW';
    };
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    /* 说明：v1.32.0：能量文本。Wh 与 mWh 分档——充电动辄 3~5 Wh，
 * 放电侧小周期可能只有几百 mWh，统一用 Wh 会全变成 0.0x。
 */
    var fmtWh = function (wh) {
        if (!(wh > 0)) return '—';
        return wh >= 1 ? wh.toFixed(2) + ' Wh' : Math.round(wh * 1000) + ' mWh';
    };
    /* 说明：v1.33.0：卡片数值自适应字号。窄屏三列卡里 21px 的 "+5.00 W" 会顶出卡片，
 * 按字符数降一档：短值保留大字，长值缩到 14px 并配合 min-w-0 防溢出。
 * 数值仍保持 nowrap（数字/单位不拆行），只调字号，不截断内容。
 */
    var numSize = function (txt, big) {
        var n = String(txt == null ? '' : txt).length;
        if (big) return n >= 8 ? 'text-[14px]' : (n >= 6 ? 'text-[17px]' : 'text-[21px]');
        return n >= 10 ? 'text-[13px]' : (n >= 8 ? 'text-[15px]' : 'text-[17px]');
    };

    function fmtClock(unixS) {
        var d = new Date(unixS * 1000);
        var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
        return hh + ':' + mm;
    }

    /* 说明：v1.21.4：周期选择浮层需要区分跨天，带月-日 */
    function fmtDayClock(unixS) {
        var d = new Date(unixS * 1000);
        var mo = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
        return mo + '-' + dd + ' ' + fmtClock(unixS);
    }

    /* 说明：v1.28.0：默认网络为独立维度，不能覆盖充放线色或息屏底纹。 */
    var NET_META = {
        '-1': { text: '未记录', color: '#cbd5e1' },
        0: { text: '无网络', color: '#64748b' },
        1: { text: 'WLAN', color: '#0ea5e9' },
        2: { text: '纯流量', color: '#f59e0b' },
        3: { text: '其他网络', color: '#8b5cf6' }
    };
    function ptNet(p) {
        var v = p && p[10];
        return typeof v === 'number' && NET_META[v] ? v : -1;
    }
    function networkSegments(hist) {
        var out = [];
        function add(a, b, kind) {
            if (!(b > a)) return;
            var prev = out[out.length - 1];
            if (prev && prev.kind === kind && prev.end === a) prev.end = b;
            else out.push({ start: a, end: b, kind: kind });
        }
        for (var i = 0; i < hist.length - 1; i++) {
            var a = hist[i][0], b = hist[i + 1][0];
            if (!(b > a)) continue;
            if ((b - a) * 1000 > MAX_STEP_MS) { add(a, b, -1); continue; }
            var ka = ptNet(hist[i]), kb = ptNet(hist[i + 1]);
            if (ka === kb) add(a, b, ka);
            else { var mid = a + (b - a) / 2; add(a, mid, ka); add(mid, b, kb); }
        }
        return out;
    }
    function networkLane(hist, x, left, right, top) {
        var els = [h('text', { key: 'label', x: left - 4, y: top + 5.5,
            textAnchor: 'end', fontSize: 7, fill: '#94a3b8' }, '网络')];
        if (hist.length > 1) els.push(h('rect', { key: 'bg', x: left, y: top,
            width: right - left, height: 6, fill: NET_META[-1].color, opacity: 0.35 }));
        networkSegments(hist).forEach(function (seg, i) {
            els.push(h('rect', { key: 'n' + i, x: x(seg.start), y: top,
                width: Math.max(0, x(seg.end) - x(seg.start)), height: 6,
                fill: NET_META[seg.kind].color, opacity: seg.kind < 0 ? 0.35 : 0.9,
                'data-net': seg.kind, 'data-start': seg.start, 'data-end': seg.end },
                h('title', {}, NET_META[seg.kind].text + ' · ' + fmtDayClock(seg.start) +
                    ' ~ ' + fmtDayClock(seg.end))));
        });
        return h('g', { key: 'netlane', 'data-network-lane': 'true', pointerEvents: 'none' }, els);
    }
    function NetworkLegend() {
        return h('div', { className: 'flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[9px] text-slate-400',
            'data-network-legend': 'true' }, [h('span', { key: 'title' }, '网络区间')].concat(
            [1, 2, 0, 3, -1].map(function (k) {
                return h('span', { key: k, className: 'flex items-center gap-1' }, [
                    h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded',
                        style: { background: NET_META[k].color, opacity: k < 0 ? 0.5 : 1 } }),
                    k < 0 ? '未记录/缺口' : NET_META[k].text]);
            })));
    }

    /* 说明：电量折线图（v1.18.0）：按放电周期展示 + 充放着色 + 单点悬浮详情。
 * opts={chg:[充放数组], pkgs:[泳道包名], hover:idx|null, onHover:fn}
 * 充电段灰色弱化、放电段绿色（核心聚焦放电趋势）；亮屏实线/息屏虚线保留。
 * 点击/按住拖动：反算最近点 → onHover(idx) → 竖线 + 圆角浮层（电量/功率/温度/前台）。
 */
    var battGeometryCache = new WeakMap();
    var BattChart = function (hist, opts) {
        opts = opts || {};
        if (!hist || hist.length < 1) return null;
        var chgA = opts.chg || [];
        var pkgs = opts.pkgs || [];
        var W = 320, H = 160;
        var padL = 30, padR = 12, padT = 14, lineH = 104;
        var pw = W - padL - padR;
        var t0 = hist[0][0], t1 = hist[hist.length - 1][0];
        if (t1 <= t0) t1 = t0 + 60;
        var x = function (t) { return padL + (t - t0) / (t1 - t0) * pw; };
        var y = function (cap) { return padT + (100 - Math.max(0, Math.min(100, cap))) / 100 * lineH; };
        /* 说明：数据数组作为弱引用键；图例改变才重建路径、底纹和网络泳道，触点不使静态图形失效。 */
        var cacheKey = JSON.stringify(opts.legend || null), cached = battGeometryCache.get(hist);
        var kids = [];
        if (cached && cached.key === cacheKey) kids = cached.kids.slice();
        else {

        /* 说明：电量网格：0/50/100% */
        [0, 50, 100].forEach(function (t) {
            kids.push(h('line', { key: 'g' + t, x1: padL, x2: W - padR, y1: y(t), y2: y(t),
                stroke: '#94a3b8', strokeWidth: 1, opacity: t === 50 ? 0.3 : 0.55 }));
            kids.push(h('text', { key: 'gt' + t, x: padL - 4, y: y(t) + 3, textAnchor: 'end',
                fontSize: 8, fill: '#94a3b8' }, t + '%'));
        });

        /* 说明：分段：只按充放状态切（颜色）。
 * v1.23.3：屏幕状态不再用虚线编码——周期一长，6-4 虚线在横轴上被压成实线，
 * 亮屏/息屏看不出区别（用户反馈「虚线点堆一起都变成线了」）。
 * 息屏改为**底纹**（见下），线色只表示充放，两个维度互不干扰。
 */
        var lg = opts.legend || null;
        var segs = [], cur = null;
        hist.forEach(function (p, i) {
            /* 说明：v1.25.0：分段键从"充/放"两态扩到"充电中/已充满/放电"三态。
 * 已充满（100% 且插着电）单独成段、用更浅的灰——它既不是充电，
 * 也不该像放电那样画成主色（用户反馈：满电插着充电器时看着像在充电）。
 */
            var k = (chgA[i] === 1) ? 'chg' : ptChgKind(p);
            if (k === 'plug') k = 'full';   /* 说明：插电未充电与已充满同属"插着电、电池不参与"，同色 */
            if (!cur || cur.k !== k) {
                cur = { k: k, chg: (k === 'chg'), pts: [] };
                if (segs.length) cur.pts.push(segs[segs.length - 1].pts[segs[segs.length - 1].pts.length - 1]);
                segs.push(cur);
            }
            cur.pts.push(p);
        });

        /* 说明：v1.23.3 息屏底纹
 * 连续 scr=0 的区间在曲线背后铺浅紫底纹（从本段首点铺到下一非息屏点）。
 * 与线型解耦后：
 * · 长周期：底纹宽度随时长自然伸缩，不会被「虚线密度」压成实线；
 * · 息屏 + 充电：灰线压在紫底纹上，两种状态同时可读（原来灰虚线=两者混在一起）；
 * · 亮屏 + 充电：灰线、无底纹。
 * legend.off=false 时整层隐藏（图例可点）。
 */
        if (!(lg && lg.off === false)) {
            var bands = [], bs = -1;
            hist.forEach(function (p, i) {
                var off = ((p.length > 3 ? p[3] : -1) === 0);
                if (off) { if (bs < 0) bs = i; }
                else if (bs >= 0) { bands.push([bs, i]); bs = -1; }
            });
            if (bs >= 0) bands.push([bs, hist.length - 1]);
            bands.forEach(function (bd, i) {
                var x0 = x(hist[bd[0]][0]);
                var x1 = x(hist[Math.min(bd[1], hist.length - 1)][0]);
                if (x1 - x0 < 1) x1 = x0 + 1;          /* 说明：单点段：至少 1px，避免不可见 */
                kids.push(h('rect', { key: 'ob' + i, x: x0, y: padT, width: x1 - x0, height: lineH,
                    fill: '#a855f7', opacity: 0.13, pointerEvents: 'none' }));
            });
        }

        segs.forEach(function (s, i) {
            if (s.pts.length < 2) return;
            var d = '';
            s.pts.forEach(function (p, j) { d += (j ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1) + ' '; });
            kids.push(h('path', { key: 'seg' + i, d: d, fill: 'none',
                /* 说明：v1.25.0：充电中=灰（弱化）；已充满/插电未充电=更浅的灰；放电=核心绿 */
                stroke: s.k === 'chg' ? '#94a3b8' : (s.k === 'full' ? '#cbd5e1' : '#22c55e'),
                strokeWidth: s.k === 'dis' ? 2 : 1.5,
                opacity: s.k === 'chg' ? 0.55 : (s.k === 'full' ? 0.5 : 1),
                strokeLinejoin: 'round', strokeLinecap: 'round' }));
        });

        /* 说明：CPU 温度平滑（v1.21.1 需求2）
 * CPU 结温原始采样毛刺密集（相邻点可跳 10°C+），叠在平缓的电量/电池温度曲线上
 * 显得突兀。这里做 5 点加权滑动平均（1-2-3-2-1 / 9），把细碎毛刺压掉，
 * 同时**全局最高点与最低点原样还原**——平滑只过滤噪声，
 * 不能抹掉「本周期最高温」这类真实峰值特征（用户明确要求保留极值）。
 * legend.smooth=false 时直接返回原始值（用户可关）。
 */
        var smoothTemp = function (vals, enable) {
            if (!enable || vals.length < 5) return vals;
            var out = vals.slice();
            /* 说明：5 点加权滑动平均（权重 1-2-3-2-1，和为 9）：比 3 点窗口更能压住
 * 细碎毛刺，同时不会把真实趋势拉平。窗口内有缺测点（<=0）则跳过该点。
 */
            for (var i = 2; i < vals.length - 2; i++) {
                var w0 = vals[i - 2], w1 = vals[i - 1], w2 = vals[i],
                    w3 = vals[i + 1], w4 = vals[i + 2];
                if (w0 <= 0 || w1 <= 0 || w2 <= 0 || w3 <= 0 || w4 <= 0) continue;
                out[i] = (w0 * 1 + w1 * 2 + w2 * 3 + w3 * 2 + w4 * 1) / 9;
            }
            /* 说明：全局最高/最低点原样还原：平滑只过滤噪声，不能抹掉「本周期最高温」
 * 这类真实极值特征（用户要求「保留最高/最低峰值特征」）。
 */
            var mxI = -1, mnI = -1, mxV = -1e9, mnV = 1e9;
            vals.forEach(function (v, i) {
                if (v <= 0) return;
                if (v > mxV) { mxV = v; mxI = i; }
                if (v < mnV) { mnV = v; mnI = i; }
            });
            if (mxI >= 0) out[mxI] = vals[mxI];
            if (mnI >= 0) out[mnI] = vals[mnI];
            return out;
        };

        /* 说明：v1.20.0 需求3-2：温度曲线叠加（独立缩放到全高，右轴 °C，图例可开关） */
        var smOn = !(opts.legend && opts.legend.smooth === false);
        var temps = [
            (lg && lg.bt === false) ? null : { k: 'bt', color: '#f59e0b', vals: hist.map(function (p) { return (p.length > 6 ? p[6] : 0) || 0; }) },
            (lg && lg.ct === false) ? null : { k: 'ct', color: '#ef4444', vals: smoothTemp(hist.map(function (p) { return (p.length > 7 ? p[7] : 0) || 0; }), smOn) }
        ].filter(Boolean);
        var tempAll = [];
        temps.forEach(function (t) { t.vals.forEach(function (v) { if (v > 0) tempAll.push(v); }); });
        if (tempAll.length >= 2) {
            var tmin = Math.min.apply(null, tempAll), tmax = Math.max.apply(null, tempAll);
            if (tmax - tmin < 3) tmax = tmin + 3; /* 说明：防平线 */
            var ty = function (v) { return padT + (1 - (v - tmin) / (tmax - tmin)) * lineH; };
            temps.forEach(function (t) {
                var d = '', started = false;
                t.vals.forEach(function (v, i) {
                    if (v <= 0) { started = false; return; }
                    d += (started ? 'L' : 'M') + x(hist[i][0]).toFixed(1) + ' ' + ty(v).toFixed(1) + ' ';
                    started = true;
                });
                if (d) kids.push(h('path', { key: 'tp_' + t.k, d: d, fill: 'none', stroke: t.color,
                    strokeWidth: 1.3, opacity: 0.9, strokeLinejoin: 'round', strokeLinecap: 'round' }));
            });
            /* 说明：温度右轴刻度（v1.21.1 需求3：2 档 → 3~5 档）。
 * 原实现只标 tmin/tmax，跨度二十几度时估读困难（用户反馈「只有 28℃、59℃
 * 两个刻度，跨度太大」）。现按跨度自适应插中间刻度，并把数值吸附到 5 的
 * 整数倍，便于口算；同时保证**至少 3 档**，避免小跨度时又退化成 2 档。
 */
            (function () {
                var span = tmax - tmin;
                /* 说明：目标等分段数 n：跨度 ≤8°C 给 2（共 3 档），≤20°C 给 3（共 4 档），
 * 更大给 4（共 5 档）。最小 3 档保证估读效率。
 */
                var n = span <= 8 ? 2 : (span <= 20 ? 3 : 4);
                var vals = [];
                var seen = {};
                for (var k = 0; k <= n; k++) {
                    var raw = tmin + span * k / n;
                    /* 说明：首尾取真实极值，中间点吸附到 5 的倍数 */
                    var snap = (k === 0) ? Math.ceil(tmin)
                             : (k === n) ? Math.floor(tmax)
                             : Math.round(raw / 5) * 5;
                    /* 说明：吸附后必须仍落在 [tmin,tmax] 内，且不与相邻档重复 */
                    if (snap < Math.ceil(tmin)) snap = Math.ceil(tmin);
                    if (snap > Math.floor(tmax)) snap = Math.floor(tmax);
                    if (!seen[snap]) { seen[snap] = 1; vals.push(snap); }
                }
                /* 说明：兜底：吸附导致去重后不足 3 档时，用原始等分点补齐 */
                if (vals.length < 3) {
                    vals = [];
                    for (var k2 = 0; k2 <= n; k2++) vals.push(Math.round(tmin + span * k2 / n));
                }
                vals.forEach(function (v, i) {
                    /* 说明：刻度线 + 文字：只给中间档画淡参考线，首尾不画（避免与网格混淆） */
                    if (i > 0 && i < vals.length - 1) {
                        kids.push(h('line', { key: 'trg' + i, x1: padL, x2: W - padR,
                            y1: ty(v), y2: ty(v), stroke: '#ef4444', strokeWidth: 1,
                            opacity: 0.12, pointerEvents: 'none' }));
                    }
                    kids.push(h('text', { key: 'trx' + i, x: W - padR + 2, y: ty(v) + 3,
                        textAnchor: 'start', fontSize: 7.5, fill: '#94a3b8' },
                        Math.round(v) + '°'));
                });
            })();
        }

        /* 说明：末点标记（v1.23.2：去掉末点旁的「xx%」数值标签）。
 * 直角坐标图只负责「看趋势」，具体数值长按曲线取浮窗——
 * 末点那个 % 与 y 轴刻度读出来的值重复，还会在曲线贴边时压住折线。
 */
        var last = hist[hist.length - 1];
        kids.push(h('circle', { key: 'dot', cx: x(last[0]), cy: y(last[1]), r: 3, fill: '#22c55e' }));

        /* 说明：X 轴时间刻度（v1.20.0 需求2-2：3 → 5，短周期波动更易定位） */
        var ticks = [[t0, 'start'], [(t0 * 3 + t1) / 4, 'middle'], [(t0 + t1) / 2, 'middle'],
            [(t0 + t1 * 3) / 4, 'middle'], [t1, 'end']];
        ticks.forEach(function (pair, i) {
            kids.push(h('text', { key: 'x' + i, x: x(pair[0]), y: padT + lineH + 28,
                textAnchor: pair[1], fontSize: 8, fill: '#94a3b8' }, fmtClock(pair[0])));
        });
        kids.push(networkLane(hist, x, padL, W - padR, padT + lineH + 5));
        kids.push(h('text', { key: 'axu', x: padL, y: padT - 5, fontSize: 8, fill: '#94a3b8' }, '电量'));

        /* 说明：v1.18.0 单点悬浮详情（v1.21.1：浮窗避手 + 指示线）
 * v1.21.1 修复：原实现浮窗贴点右侧、纵向夹在绘图区内，手指按住曲线时
 * 浮窗常被手指盖住。现改为：默认放触摸点上方（避开手指），上方放不下翻下方，
 * 横向夹在绘图区内；并给浮窗内容加 pointer-events:none，避免遮挡后续取点。
 */
            battGeometryCache.set(hist, { key: cacheKey, kids: kids.slice() });
        }
        var hv = opts.hover;
        if (hv != null && hist[hv]) {
            var p = hist[hv];
            var hx = x(p[0]), hy = y(p[1]);
            kids.push(h('line', { key: 'hvl', x1: hx, x2: hx, y1: padT, y2: padT + lineH,
                stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8,
                pointerEvents: 'none' }));
            kids.push(h('circle', { key: 'hvc', cx: hx, cy: hy, r: 4, fill: '#6366f1',
                stroke: '#fff', strokeWidth: 1.5, pointerEvents: 'none' }));
            var appName = (p[2] >= 0 && pkgs[p[2]]) ? pkgs[p[2]] : '无前台';
            if (appName.length > 16) appName = appName.slice(0, 15) + '…';
            var mwV = (p.length > 5 ? p[5] : 0) || 0;
            var btV = (p.length > 6 ? p[6] : 0) || 0;
            var ctV = (p.length > 7 ? p[7] : 0) || 0;
            /* 说明：v1.23.3：补「屏幕状态 · 充放状态」一行。
 * 图上息屏是底纹、充电是灰线，两者叠加时（息屏 + 充电）需要有个地方
 * 把状态说清楚，否则只能靠颜色猜。
 */
            var scrV = (p.length > 3 ? p[3] : -1);
            var touV = (p.length > 8 ? p[8] : -1);
            /* 说明：v1.25.0：充放状态按"充电中 / 已充满 / 插电未充电 / 放电中"如实显示。
 * 满电 100% 插着充电器时是"已充满"，不再误报"充电中"。
 */
            var stateTxt = (scrV === 0 ? '息屏' : (scrV === 1 ? (touV === 1 ? '触摸亮屏' : '静止亮屏') : '屏幕未知')) +
                ' · ' + CHG_KIND_TEXT[ptChgKind(p)];
            var rows = [
                fmtClock(p[0]) + ' · 电量 ' + p[1] + '%',
                stateTxt,
                '网络 ' + NET_META[ptNet(p)].text,
                '功率 ' + (mwV > 0 ? fmtW(mwV) : '未记录'),
                '电池 ' + (btV > 0 ? btV.toFixed(1) + '°C' : '未记录') +
                    ' · CPU ' + (ctV > 0 ? ctV.toFixed(0) + '°C' : '未记录'),
                '前台 ' + appName
            ];
            appendPointFloat(kids, rows, hx, hy, padL, W - padR, padT, padT + lineH);
        }

        /* 说明：事件：单击轻触取点（v1.21.1 修复核心）。
 * 原实现里 onPointerDown 就出浮窗，但移动端长按会选中文本、系统弹复制菜单，
 * 与图表手势抢占；且 element 未禁用 touch-callout，长按必弹菜单。
 * 现改为：
 * - 整个图区禁用文本选择（user-select:none + -webkit-touch-callout:none），
 * 从根上不弹系统菜单；touch-action:pan-y 允许页面纵向滚动，横向留给图表；
 * - **按下即出浮窗**（手指一接触就给反馈，符合「点曲线看详情」的即时感），
 * 拖动时实时跟随——这是移动端图表的标准做法；
 * - 抬手后延迟 300ms 再隐藏，避免手指一离屏浮窗就闪没；
 * - 点击图表外空白区由页面级监听关闭。
 * 注：这里用 pointerdown 而非 pointerup，是因为移动端 pointerup 到
 * click 之间可能有 300ms 延迟，按下即响应才「跟手」。系统菜单已被
 * touch-callout:none + user-select:none 从源头关掉，不存在抢占。
 */
        var dragging = false;
        var pick = function (e) {
            var r = e.currentTarget.getBoundingClientRect();
            if (!r.width || !opts.onHover) return;
            var xx = (e.clientX - r.left) / r.width * W;
            var tt = t0 + (xx - padL) / pw * (t1 - t0);
            /* 说明：有序时间戳用二分定位最近原始采样，长周期拖动不再逐点扫描。 */
            var lo = 0, hi = hist.length - 1;
            while (lo < hi) { var mid = (lo + hi) >>> 1; if (hist[mid][0] < tt) lo = mid + 1; else hi = mid; }
            var best = lo;
            if (lo > 0 && Math.abs(hist[lo - 1][0] - tt) <= Math.abs(hist[lo][0] - tt)) best = lo - 1;
            opts.onHover(best);
        };
        var hideLater = function () {
            if (!opts.onHover) return;
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(function () { opts.onHover(null); hideTimer = null; }, POINT_HIDE_MS);
        };
        return h('svg', { viewBox: '0 0 ' + W + ' ' + H, className: 'w-full',
            style: {
                display: 'block',
                touchAction: 'pan-y',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none'
            },
            onPointerDown: function (e) {
                dragging = true;
                if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
                pick(e);
            },
            onPointerMove: function (e) {
                if (dragging || e.buttons === 1) pick(e);
            },
            onPointerUp: function () { dragging = false; hideLater(); },
            onPointerCancel: function () { dragging = false; hideLater(); },
            onPointerLeave: hideLater
        }, kids);
    };

    /* 说明：同一图内浮窗：上方优先、下方备选，左右避开触点并夹在绘图区内。 */
    function appendPointFloat(kids, rows, hx, hy, left, right, top, bottom, marker) {
        var bw = 158, bh = rows.length * 11 + 8, gap = 12;
        var by = hy - bh - gap;
        if (by < top) by = hy + gap;
        if (by + bh > bottom) by = Math.max(top, bottom - bh);
        var bx = hx + gap;
        if (bx + bw > right) bx = hx - gap - bw;
        bx = Math.max(left, Math.min(bx, right - bw));
        kids.push(h('rect', { key: 'hvb', x: bx, y: by, width: bw, height: bh, rx: 6,
            fill: '#0f172a', opacity: 0.9, pointerEvents: 'none', 'data-charge-point': marker }));
        rows.forEach(function (t, i) {
            kids.push(h('text', { key: 'hvt' + i, x: bx + 6, y: by + 14 + i * 11,
                fontSize: 8.5, fill: '#e2e8f0', pointerEvents: 'none',
                'data-charge-float-row': marker ? i : undefined }, t));
        });
    }

    /* 说明：浮窗延迟隐藏定时器（每次调用 BattChart 复用一个槽位，避免闭包外泄） */
    var hideTimer = null;

    /* 说明：分时段功率曲线（v1.19.0 二级入口①；v1.23.3 分档着色 + 双参考线）。
 * series=[{t,mw,chg,kind}]，kind = touch / idle / off；充电段统一灰。
 * refs={all,on}：整机平均与亮屏平均（亮屏 = 静止 + 触摸，按时长加权）。
 * 用户需求：「分段功率走势图都要有；有整机的平均功耗，再加一个亮屏功耗」。
 */
    var PWR_KIND_COLOR = { touch: '#6366f1', idle: '#0ea5e9', off: '#a855f7' };
    var PwrChart = function (series, refs) {
        if (!series || series.length < 2) return null;
        refs = refs || {};
        var W = 320, H = 148;
        var padL = 34, padR = 10, padT = 14, padB = 38;
        var pw = W - padL - padR, ph = H - padT - padB;
        var nh = refs.hist || [];
        var t0 = nh.length ? nh[0][0] : series[0].t;
        var t1 = nh.length ? nh[nh.length - 1][0] : series[series.length - 1].t;
        if (t1 <= t0) t1 = t0 + 60;
        var mx = 0;
        series.forEach(function (p) { if (p.mw > mx) mx = p.mw; });
        if (mx <= 0) mx = 1;
        mx = mx * 1.1;
        var x = function (t) { return padL + (t - t0) / (t1 - t0) * pw; };
        var y = function (v) { return padT + ph - (Math.min(v, mx) / mx) * ph; };
        var kids = [];
        /* 说明：Y 轴刻度 0 / 半 / 峰（W） */
        [0, mx / 2, mx].forEach(function (v) {
            kids.push(h('line', { key: 'g' + v, x1: padL, x2: W - padR, y1: y(v), y2: y(v),
                stroke: '#94a3b8', strokeWidth: 1, opacity: v === 0 ? 0.6 : 0.28 }));
            kids.push(h('text', { key: 'gt' + v, x: padL - 4, y: y(v) + 3, textAnchor: 'end',
                fontSize: 8, fill: '#94a3b8' }, (v / 1000).toFixed(1)));
        });
        kids.push(h('text', { key: 'u', x: 2, y: padT - 4, fontSize: 8, fill: '#94a3b8' }, 'W'));
        /* 说明：整机平均（橙虚线）：所有放电点的均值，与三档卡的「整机平均」同值。
 * v1.26.0：数值标签从图内移出——图里只留虚线本身（线的位置已经说明高低），
 * 「整机 / 亮屏 各是多少」统一放到图例下方那一行（见下方图例块）。
 * 原因：320 宽里两条参考线的数值标签会压住折线，且右对齐后紧贴 y 轴刻度。
 */
        if (refs.all > 0) {
            kids.push(h('line', { key: 'av', x1: padL, x2: W - padR, y1: y(refs.all), y2: y(refs.all),
                stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.9 }));
        }
        /* 说明：亮屏平均（青虚线）：静止亮屏 + 触摸亮屏按时长加权，比整机平均高，
 * 用来一眼看出「亮屏把功耗抬了多少」。与整机线重叠时不重复画。
 */
        if (refs.on > 0 && Math.abs(refs.on - (refs.all || 0)) > 5) {
            kids.push(h('line', { key: 'av2', x1: padL, x2: W - padR, y1: y(refs.on), y2: y(refs.on),
                stroke: '#14b8a6', strokeWidth: 1, strokeDasharray: '2 3', opacity: 0.9 }));
        }
        /* 说明：折线：按「档位 + 充放」分段着色（触摸靛 / 静止天蓝 / 息屏紫 / 充电或插电灰） */
        var segs = [], cur = null;
        series.forEach(function (p) {
            var k = (p.chg === 1 || p.plg === 1) ? 'chg' : (p.kind || 'off');
            if (!cur || cur.k !== k) { cur = { k: k, pts: [] }; segs.push(cur); }
            cur.pts.push(p);
        });
        segs.forEach(function (s, i) {
            if (s.pts.length < 2) return;
            var d = '';
            s.pts.forEach(function (p, j) { d += (j ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.mw).toFixed(1) + ' '; });
            kids.push(h('path', { key: 's' + i, d: d, fill: 'none',
                stroke: s.k === 'chg' ? '#94a3b8' : (PWR_KIND_COLOR[s.k] || '#8b5cf6'),
                strokeWidth: 1.8, opacity: s.k === 'chg' ? 0.5 : 1,
                strokeLinejoin: 'round', strokeLinecap: 'round' }));
        });
        kids.push(networkLane(refs.hist || [], x, padL, W - padR, padT + ph + 5));
        /* 说明：X 轴时间 */
        [[t0, 'start'], [t1, 'end']].forEach(function (pair, i) {
            kids.push(h('text', { key: 'x' + i, x: x(pair[0]), y: H - 6,
                textAnchor: i ? 'end' : 'start', fontSize: 8, fill: '#94a3b8' }, fmtClock(pair[0])));
        });
        return h('svg', { viewBox: '0 0 ' + W + ' ' + H, className: 'w-full',
            style: { display: 'block' } }, kids);
    };

    /* 说明：采样跨度与续航估算参数（集中在文件顶部，改参数不必翻业务代码）
 * NOMINAL_STEP_MS：hist 每针的标称间隔。C 侧「距上针 ≥60s 才记」，60s 只是下限。
 * MAX_STEP_MS：单针最大计入跨度——超过就是守护停机/关机，那段没有采样，
 * 不能整段算给上一针（300s 为经验值，可调）。
 */
    var NOMINAL_STEP_MS = 60000, MAX_STEP_MS = 300000;

    /* 说明：该针代表的真实跨度（毫秒）：取到下一针的间隔，末针按标称值。
 * v1.23.1：原来一律按 60s 计，实测中位 61s、均值 66s，三档与排行时长系统性少算 ~9%。
 * v1.23.2：从 BatteryPage 内部提到文件顶部，理论续航的能量积分与三档时长共用同一口径。
 */
    function histStepMs(arr, i) {
        if (i < arr.length - 1) {
            var d = (arr[i + 1][0] - arr[i][0]) * 1000;
            return Math.max(0, Math.min(d, MAX_STEP_MS));
        }
        return NOMINAL_STEP_MS;
    }

    /* 说明：v1.25.0：单点充放状态判读（与 C 侧 features/profile/chg_state.h 同构）。
 * hist 第 10 位 plg = 插电标记（1 插着 / 0 未插 / -1 旧数据或节点不可用）。
 * 关键场景：100% 插着充电器时 chg=0、plg=1 → 'full'（已充满），
 * 不再把"电还插着"显示成"充电中"（用户反馈的误判）。
 * 旧数据（dump v14 及更早）plg=-1 → 退回只看 chg，行为与旧版一致。
 */
    function ptChgKind(p) {
        var chgV = (p.length > 4 ? p[4] : 0);
        if (chgV === 1) return 'chg';
        var plgV = (p.length > 9 ? p[9] : -1);
        if (plgV === 1) return ((p[1] || 0) >= 100 ? 'full' : 'plug');
        if (plgV === 0) return 'dis';
        return 'dis';
    }
    /* 说明：状态文案：图上/浮层/实时卡共用，避免三处各写一套导致口径不一致 */
    var CHG_KIND_TEXT = { chg: '充电中', full: '已充满', plug: '插电未充电', dis: '放电中' };

    /* 说明：v1.32.0 充电会话切分（纯函数：零 IO、无 DOM、无 state）
 * 需求：耗电页此前只有放电侧统计（三档功耗 / 理论续航 / 应用排行全是放电口径），
 * 充电侧除了曲线上一条灰线，没有任何数值。这里从 hist 切出「充电会话」，
 * 与放电周期并列，作为充电统计与充电功率曲线的唯一数据源。
 * 
 * 会话定义：hist 中「连续非放电」的极大区间，且区间内至少有一针 chg=1
 * （真的向电池充入了电流）。插电未充电（限流 / 温控暂停，从未充入）不算充电会话——
 * 那是插着电待机，与充进电量是两件事。
 * 
 * 口径（全与三档功耗同源，避免同页两个时间/能量互相矛盾）：
 * · 会话时长 wallMs：每针到下一针的真实墙钟累计（histStepMs，>300s 视为停机夹断）；
 * · 充电时长 chgMs：只累计 chg=1 的针——已充满/插电未充不是充电；
 * · 功率/能量只取 chg=1 且 mw>0 的针。hist 的 mw 是 C 侧 |µA|×µV÷1e9 的
 * *绝对值**（prof_read_power_mw 取绝对值），充电与放电都是正数，
 * 方向只能由 chg/plg 位判断，不能看符号；
 * · 充入电量按 cap 增长算百分比（不猜电池电压），折算 mAh 由 UI 用标称容量算并标注。
 */
    function chgSessions(hist) {
        var out = { list: [], last: null };
        if (!hist || hist.length < 2) return out;
        var segs = [], st = -1, i;
        for (i = 0; i < hist.length; i++) {
            if (ptChgKind(hist[i]) !== 'dis') { if (st < 0) st = i; }
            else if (st >= 0) { segs.push([st, i - 1]); st = -1; }
        }
        if (st >= 0) segs.push([st, hist.length - 1]);
        segs.forEach(function (rng) {
            var a = rng[0], b = rng[1], k;
            var pts = [], nChg = 0, chgMs = 0, wallMs = 0;
            var pwSum = 0, pwMs = 0, pwPeak = 0, eWh = 0;
            var btLo = 0, btHi = 0, capLo = -1, capHi = -1;
            for (k = a; k <= b; k++) {
                var p = hist[k];
                var w = histStepMs(hist, k);
                var kind = ptChgKind(p);
                var cap = (typeof p[1] === 'number') ? p[1] : -1;
                var mw = (p.length > 5 ? p[5] : 0) || 0;
                var bt = (p.length > 6 ? p[6] : 0) || 0;
                wallMs += w;
                if (cap >= 0) {
                    if (capLo < 0 || cap < capLo) capLo = cap;
                    if (capHi < 0 || cap > capHi) capHi = cap;
                }
                /* 说明：温度只取这段插电过程里的真实读数（0 = 读失败，不参与区间） */
                if (bt > 0) {
                    if (!(btLo > 0) || bt < btLo) btLo = bt;
                    if (bt > btHi) btHi = bt;
                }
                if (kind === 'chg') {
                    nChg++;
                    chgMs += w;
                    if (mw > 0) {
                        pwSum += mw * w; pwMs += w;
                        if (mw > pwPeak) pwPeak = mw;
                        /* 说明：单位：mW × ms → Wh 要除 3.6e9（1 Wh = 1000 mW × 3 600 000 ms），
 * 不是 3.6e6——那是 mW·h，差 1000 倍。
 */
                        eWh += mw * w / 3.6e9;
                    }
                }
                if (mw > 0) pts.push({ t: p[0], cap: cap, mw: mw, kind: kind, histIndex: k });
            }
            if (!nChg) return;                 /* 说明：只插着电没充入：不是充电会话 */
            out.list.push({
                s: a, e: b,
                t0: hist[a][0], t1: hist[b][0],
                wallMs: wallMs, chgMs: chgMs,
                capLo: capLo, capHi: capHi,
                capGain: (capLo >= 0 && capHi >= 0) ? Math.max(capHi - capLo, 0) : 0,
                pwAvg: pwMs > 0 ? pwSum / pwMs : 0,
                pwPeak: pwPeak,
                eWh: eWh,
                btLo: btLo, btHi: btHi,
                nChg: nChg, pts: pts,
                ongoing: (b === hist.length - 1)
            });
        });
        out.last = out.list.length ? out.list[out.list.length - 1] : null;
        return out;
    }

    /* 说明：充电曲线保留功率、电量和坐标轴，点值只在选点时悬浮在图内。 */
    var ChargeChart = function (sess, selected, sample, pkgs, onSelect, hideLater) {
        if (!sess || !sess.pts || sess.pts.length < 2) return null;
        var W = 320, H = 150;
        var padL = 34, padR = 30, padT = 14, padB = 30;
        var pw = W - padL - padR, ph = H - padT - padB;
        var x0 = sess.pts[0].t, x1 = sess.pts[sess.pts.length - 1].t;
        if (!(x1 > x0)) x1 = x0 + 60;
        var mx = Math.max(sess.pwPeak || 0, sess.pwAvg || 0, 1) * 1.12;
        var x = function (p) { return padL + (p.t - x0) / (x1 - x0) * pw; };
        var y = function (v) { return padT + ph - (Math.min(v, mx) / mx) * ph; };
        var py = function (v) { return padT + ph - (Math.max(0, Math.min(100, v)) / 100) * ph; };
        var kids = [];
        /* 说明：Y 轴：0 / 半 / 峰（W）。充电功率的量级在瓦级，用一位小数刻度够读。 */
        [0, mx / 2, mx].forEach(function (v) {
            kids.push(h('line', { key: 'g' + v, x1: padL, x2: W - padR, y1: y(v), y2: y(v),
                stroke: '#94a3b8', strokeWidth: 1, opacity: v === 0 ? 0.6 : 0.28 }));
            kids.push(h('text', { key: 'gt' + v, x: padL - 4, y: y(v) + 3, textAnchor: 'end',
                fontSize: 8, fill: '#94a3b8' }, (v / 1000).toFixed(1)));
        });
        kids.push(h('text', { key: 'u', x: 2, y: padT - 4, fontSize: 8, fill: '#94a3b8' }, 'W'));
        /* 说明：面积：充电功率越靠外越"快"，用低透明度填充让平台段更醒目 */
        var dArea = 'M' + x(sess.pts[0]).toFixed(1) + ' ' + y(0).toFixed(1) + ' ';
        sess.pts.forEach(function (p) { dArea += 'L' + x(p).toFixed(1) + ' ' + y(p.mw).toFixed(1) + ' '; });
        dArea += 'L' + x(sess.pts[sess.pts.length - 1]).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';
        kids.push(h('path', { key: 'area', d: dArea, fill: '#14b8a6', opacity: 0.14, stroke: 'none' }));
        /* 说明：电量线只绘制有效读数，-1（缺测）不画成 0%。 */
        var capPts = sess.pts.filter(function (p) { return p.cap >= 0 && p.cap <= 100; });
        if (capPts.length >= 2) {
            [0, 50, 100].forEach(function (v) {
                kids.push(h('text', { key: 'pct' + v, x: W - padR + 3, y: py(v) + 3,
                    textAnchor: 'start', fontSize: 7, fill: '#16a34a' }, v + '%'));
            });
            kids.push(h('text', { key: 'pcu', x: W - padR + 3, y: padT - 4,
                fontSize: 7, fill: '#16a34a' }, '电量'));
            var cd = '';
            capPts.forEach(function (p, j) {
                cd += (j ? 'L' : 'M') + x(p).toFixed(1) + ' ' + py(p.cap).toFixed(1) + ' ';
            });
            kids.push(h('path', { key: 'capline', d: cd, fill: 'none', stroke: '#16a34a',
                strokeWidth: 1.6, opacity: 0.9, strokeLinejoin: 'round', strokeLinecap: 'round',
                'data-charge-cap-line': 'true' }));
        }
        /* 说明：折线：按充放状态分段——充电中实线，已充满/插电未充虚线弱化
 * （后半段功率是"维持电量"的涓流，与快充段不是同一件事）
 */
        var segs2 = [], cur = null;
        sess.pts.forEach(function (p) {
            if (!cur || cur.k !== p.kind) { cur = { k: p.kind, pts: [] }; segs2.push(cur); }
            cur.pts.push(p);
        });
        segs2.forEach(function (s, i) {
            if (!s.pts.length) return;
            var d = '';
            s.pts.forEach(function (p, j) { d += (j ? 'L' : 'M') + x(p).toFixed(1) + ' ' + y(p.mw).toFixed(1) + ' '; });
            var solid = (s.k === 'chg');
            kids.push(h('path', { key: 's' + i, d: d, fill: 'none',
                stroke: solid ? '#0d9488' : '#94a3b8',
                strokeWidth: solid ? 1.9 : 1.4,
                strokeDasharray: solid ? null : '3 3',
                opacity: solid ? 1 : 0.75,
                strokeLinejoin: 'round', strokeLinecap: 'round' }));
        });
        /* 说明：平均功率虚线：与卡片上的「平均充电功率」同值，图里只留线，数值在图例 */
        if (sess.pwAvg > 0) {
            kids.push(h('line', { key: 'avg', x1: padL, x2: W - padR, y1: y(sess.pwAvg), y2: y(sess.pwAvg),
                stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.9 }));
        }
        /* 说明：峰值点：只标一个——峰值是"这段充电最快的一刻"，多个点会糊成一片 */
        var pk = null;
        sess.pts.forEach(function (p) { if (!pk || p.mw > pk.mw) pk = p; });
        if (pk) {
            kids.push(h('circle', { key: 'pk', cx: x(pk).toFixed(1), cy: y(pk.mw).toFixed(1), r: 2.6,
                fill: '#0d9488', stroke: '#fff', strokeWidth: 1, 'data-charge-peak': 'true' }));
        }
        /* 说明：X 轴：固定时间轴，首/中/末三个时刻刻度（8px 在 320 宽内可读）。 */
        var ticks = [x0, x0 + (x1 - x0) / 2, x1];
        ticks.forEach(function (tv, i) {
            kids.push(h('text', { key: 'x' + i, x: padL + pw * i / 2, y: H - 6,
                textAnchor: i === 0 ? 'start' : (i === 2 ? 'end' : 'middle'),
                fontSize: 8, fill: '#94a3b8' }, fmtClock(tv)));
        });
        kids.push(h('text', { key: 'xl', x: W - padR, y: H - 16, textAnchor: 'end',
            fontSize: 7, fill: '#94a3b8' }, '时刻'));
        if (selected) {
            var sx = x(selected), sy = y(selected.mw);
            kids.push(h('line', { key: 'selected', 'data-charge-crosshair': 'true',
                x1: sx, x2: sx, y1: padT, y2: padT + ph, stroke: '#6366f1',
                strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.8, pointerEvents: 'none' }));
            kids.push(h('circle', { key: 'selected-power', cx: sx, cy: sy, r: 4,
                fill: '#6366f1', stroke: '#fff', strokeWidth: 1.5, pointerEvents: 'none' }));
            if (capPts.length >= 2 && selected.cap >= 0 && selected.cap <= 100) {
                kids.push(h('circle', { key: 'selected-cap', cx: sx, cy: py(selected.cap), r: 3.5,
                    fill: '#16a34a', stroke: '#fff', strokeWidth: 1, pointerEvents: 'none' }));
            }
            appendPointFloat(kids, chargePointRows(selected, sample, pkgs), sx, sy,
                padL, W - padR, padT, padT + ph, 'float');
        }
        /* 说明：透明命中区覆盖绘图区的空白；按时间匹配最近的实测点，不插值。 */
        kids.push(h('rect', { key: 'hit', x: padL, y: padT, width: pw, height: ph, fill: 'transparent' }));
        var pick = function (e) {
            var r = e.currentTarget.getBoundingClientRect();
            if (!(r.width > 0) || !isFinite(e.clientX)) return;
            var xx = (e.clientX - r.left) / r.width * W;
            var ts = x0 + Math.max(0, Math.min(1, (xx - padL) / pw)) * (x1 - x0);
            var best = sess.pts[0];
            sess.pts.forEach(function (p) {
                if (Math.abs(p.t - ts) < Math.abs(best.t - ts)) best = p;
            });
            onSelect(best);
        };
        return h('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
            className: 'w-full cursor-crosshair focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600',
            style: { display: 'block', touchAction: 'pan-y', userSelect: 'none',
                WebkitUserSelect: 'none', WebkitTouchCallout: 'none' },
            tabIndex: 0, role: 'group', 'aria-label': '充电曲线采样点', 'data-charge-chart': 'time',
            onPointerDown: function (e) {
                if (e.button !== 0 || e.isPrimary === false) return;
                var svg = e.currentTarget;
                if (svg.setPointerCapture && e.pointerId != null) svg.setPointerCapture(e.pointerId);
                pick(e);
            },
            onPointerMove: function (e) {
                if ((e.buttons & 1) && e.isPrimary !== false) pick(e);
            },
            onPointerUp: function (e) { if (e.isPrimary !== false && e.button === 0) hideLater(); },
            onPointerCancel: function (e) { if (e.isPrimary !== false) hideLater(); },
            onPointerLeave: function (e) { if (e.isPrimary !== false) hideLater(); },
            onClick: function (e) {
                if (e.detail === 0 && !selected) onSelect(sess.pts[0]);
            },
            onKeyDown: function (e) {
                var i = sess.pts.indexOf(selected), last = sess.pts.length - 1;
                switch (e.key) {
                case 'ArrowLeft': i = Math.max(0, i - 1); break;
                case 'ArrowRight': i = Math.min(last, i + 1); break;
                case 'Home': i = 0; break;
                case 'End': i = last; break;
                case 'Enter': case ' ': i = Math.max(0, i); break;
                case 'Escape': e.preventDefault(); onSelect(null); return;
                default: return;
                }
                e.preventDefault();
                onSelect(sess.pts[i]);
            }
        }, kids);
    };

    /* 说明：读取对应的 hist 原针；按放电浮窗的六行节奏排版，长包名仅缩写在图中。 */
    function chargePointRows(p, sample, pkgs) {
        var app = sample[2] >= 0 ? pkgs[sample[2]] : null;
        if (typeof app !== 'string') app = sample[2] === -1 ? '无前台' : '未记录';
        if (app.length > 16) app = app.slice(0, 15) + '…';
        var screen = sample[3] === 0 ? '息屏' : (sample[3] === 1
            ? (sample[8] === 1 ? '触摸亮屏' : (sample[8] === 0 ? '静止亮屏' : '亮屏')) : '屏幕未知');
        var temp = function (v, digits) {
            return typeof v === 'number' && isFinite(v) && v > 0 ? v.toFixed(digits) + '°C' : '未记录';
        };
        return [
            fmtClock(p.t) + ' · 电量 ' + (p.cap >= 0 && p.cap <= 100 ? p.cap + '%' : '未记录'),
            screen + ' · ' + CHG_KIND_TEXT[p.kind],
            '网络 ' + NET_META[ptNet(sample)].text,
            '功率 ' + fmtW(p.mw),
            '电池 ' + temp(sample[6], 1) + ' · CPU ' + temp(sample[7], 0),
            '前台 ' + app
        ];
    }

    /* 说明：理论续航的可调参数（v1.23.2）：
 * ETA_V_NOM   标称电压 V —— 本周期掉电不足以做能量校准时的兜底。3.85 是锂离子电池
 * 放电平台的经验值（外部知识，可调）；能实测校准时**不会**用到它。
 * ETA_MIN_DROP 做能量校准所需的最小周期掉电%。电量是整数，掉电太小时 1% 的量化
 * 误差就能把 mWh/% 带偏一倍。
 * ETA_MIN_N   某档给区间所需的最少样本数；不足只给单值，不编造区间。
 * ETA_Q_LO/HI 区间分位点：取该档功率的 25%/75% 分位（最省电/最费电的四分之一时段）。
 */
    var ETA_V_NOM = 3.85, ETA_MIN_DROP = 5, ETA_MIN_N = 8;
    var ETA_Q_LO = 0.25, ETA_Q_HI = 0.75;

    /* 说明：v1.23.2 理论续航预测（领域层纯计算：无 IO、无 DOM、无 state）
 * 需求：加回理论续航，按「整机平均 / 静止亮屏 / 触摸亮屏 / 息屏」四档预测，
 * 并**直接给出区间（最短 ~ 最长）**——单点值假装精确，用户要的是范围。
 * 
 * 模型：剩余能量 ÷ 该档平均功率 = 可用时长。
 * · 剩余能量 E = 当前电量% × 每 1% 能量(mWh/%)；
 * · 每 1% 能量优先用**本周期实测校准**：周期放电能量 ÷ 周期掉电%。
 * 好处：不用假设电池电压，电池老化（实际容量衰减）自动吸收进系数；
 * · 周期掉电不足 ETA_MIN_DROP 时退回「标称容量 × 标称电压」，UI 标注口径；
 * · 区间取该档功率的**时间加权** 25%/75% 分位：功率低 → 撑得久（最长），
 * 功率高 → 撑得短（最短）；样本不足 ETA_MIN_N 时退化为单值，不编造区间。
 * 注：v1.23.0 删掉的旧实现（estimateEta）走的是「曲线尾部 ≤2h 的 %/h 外推」，
 * 与三档功耗卡的功率口径不同源，同一个页面能给出互相矛盾的两个数，故一并替换。
 */

    /* 说明：时间加权分位（pts=[[功率mW, 权重ms], ...]）。
 * 普通分位按「点数」平均，而 hist 采样间隔并不均匀（实测 60~150s），
 * 长时段会被低估；这里按时间占比累计取分位，与三档时长同一口径。
 * 命中段内做线性插值，避免分位值跳到采样点边界上。
 */
    function wQuantile(pts, q) {
        if (!pts || !pts.length) return 0;
        var a = pts.slice().sort(function (x, y) { return x[0] - y[0]; });
        var tot = 0, i;
        for (i = 0; i < a.length; i++) tot += a[i][1];
        if (!(tot > 0)) return a[Math.floor((a.length - 1) * q)][0];
        var target = tot * q, acc = 0;
        for (i = 0; i < a.length; i++) {
            if (acc + a[i][1] >= target) {
                if (i === 0 || !(a[i][1] > 0)) return a[i][0];
                var f = (target - acc) / a[i][1];
                return a[i - 1][0] + (a[i][0] - a[i - 1][0]) * Math.max(0, Math.min(1, f));
            }
            acc += a[i][1];
        }
        return a[a.length - 1][0];
    }

    /* 说明：每 1% 电量对应的能量（mWh/%）。
 * 返回 { v, src }：src='cal' 本周期实测校准 / 'cap' 标称容量折算 / null 无数据。
 */
    function energyPerPct(pts, dropPct, fullUa) {
        var e = 0, n = 0, i;
        if (pts && pts.length) {
            for (i = 0; i < pts.length; i++) {
                var p = pts[i];
                if ((p.length > 4 ? p[4] : 0) === 1 || (p.length > 9 ? p[9] : -1) === 1) continue; /* 说明：充电与插电期不计（同三档口径） */
                var mw = (p.length > 5 ? p[5] : 0) || 0;
                if (mw > 0) { e += mw * histStepMs(pts, i) / 3600000; n++; }
            }
        }
        if (e > 0 && n >= ETA_MIN_N && dropPct >= ETA_MIN_DROP) {
            return { v: e / dropPct, src: 'cal' };
        }
        var mah = (fullUa || 0) / 1000;
        if (mah > 0) return { v: mah * ETA_V_NOM / 100, src: 'cap' };
        return { v: 0, src: null };
    }

    /* 说明：四口径续航：stats = cycStats（含每档 avg 与时间加权样本 pts）。
 * 返回 { ok, capPct, mWhPerPct, src, rows[] }，rows 每项：
 * { key,label,color, p, midH, minH, maxH, rng, n }
 * minH=最短（功率高位）、maxH=最长（功率低位）、midH=按均值。
 */
    function etaPredict(stats, capPct, mWhPerPct) {
        var out = { ok: false, capPct: 0, mWhPerPct: 0, eRem: 0, src: null, rows: [] };
        if (!stats || !(capPct > 0) || !(mWhPerPct > 0)) return out;
        var eRem = capPct * mWhPerPct;          /* 说明：剩余可用能量（mWh） */
        if (!(eRem > 0)) return out;
        /* 说明：顺序按需求原文：整机平均 → 整机亮屏 → 静止亮屏 → 触摸亮屏 → 整机息屏。
 * v1.23.3：新增「整机亮屏」档（静止 + 触摸按时长加权），与平均功耗卡的整机亮屏行同源。
 * v1.34.0：亮屏/息屏统一改称整机亮屏/整机息屏。
 */
        var defs = [
            ['all', '整机平均', 'bg-slate-400'],
            ['on', '整机亮屏', 'bg-teal-400'],
            ['idle', '静止亮屏', 'bg-sky-400'],
            ['touch', '触摸亮屏', 'bg-brand-500'],
            ['off', '整机息屏', 'bg-violet-400']
        ];
        out.ok = true;
        out.capPct = capPct;
        out.eRem = eRem;
        out.rows = defs.map(function (d) {
            var s = stats[d[0]] || {};
            var p = s.avg || 0;
            var row = { key: d[0], label: d[1], color: d[2], p: p, n: (s.pts || []).length,
                midH: 0, minH: 0, maxH: 0, rng: false };
            if (!(p > 0)) return row;
            row.midH = eRem / p;
            var sp = s.pts || [];
            if (sp.length >= ETA_MIN_N) {
                var lo = wQuantile(sp, ETA_Q_LO), hi = wQuantile(sp, ETA_Q_HI);
                if (lo > 0 && hi > lo) {
                    row.maxH = eRem / lo;           /* 说明：功率最低的 1/4 时段 → 最长 */
                    row.minH = eRem / hi;           /* 说明：功率最高的 1/4 时段 → 最短 */
                    row.rng = row.maxH > row.minH;
                }
            }
            if (!row.rng) { row.minH = row.midH; row.maxH = row.midH; }
            /* 说明：中心值必须落在区间内：C 侧均值（5s 采样）与 hist 分位（60s 采样）
 * 来自不同采样密度，极端情况下会差一点点，夹一下避免「中心在区间外」。
 */
            if (row.midH > row.maxH) row.midH = row.maxH;
            if (row.midH < row.minH) row.midH = row.minH;
            return row;
        });
        return out;
    }

    function splitCycles(hist) {
    var ptChg = [], ptSup = [];
        if (hist) {
            for (var hi = 0; hi < hist.length; hi++) {
                var hp = hist[hi], hc;
                if (hp.length > 4 && hp[4] >= 0) hc = hp[4];
                else if (hi > 0) hc = hp[1] < hist[hi - 1][1] ? 0
                    : (hp[1] > hist[hi - 1][1] ? 1 : (ptChg[hi - 1] || 0));
                else hc = 0;
                ptChg.push(hc);
                var hplg = (hp.length > 9 ? hp[9] : -1);
                ptSup.push((hc === 1 || hplg === 1) ? 1 : 0);
            }
        }
        var cycles = [];
        if (hist) {
            var cySt = -1;
            for (var ci = 0; ci < hist.length; ci++) {
                var unplug = (ptSup[ci] === 0 && (ci === 0 || ptSup[ci - 1] === 1));
                if (unplug) {
                    if (cySt >= 0) cycles.push({ s: cySt, e: ci });
                    cySt = ci;
                }
            }
            if (cySt >= 0) cycles.push({ s: cySt, e: hist.length });
            else cycles.push({ s: 0, e: hist.length }); /* 说明：无明确拔电沿（如全程仍在插电）：整段展示 */
        }
        return { cycles: cycles, charging: ptChg };
    }

    function aggregateApps(prof, cyclePts) {
            var out = {};
            if (!cyclePts.length || !prof || !prof.hist_pkgs) return out;
            var pkgs = prof.hist_pkgs;
            /* 说明：v1.21.7 修复：hist 每针**至少** 60 秒（C 侧 prof_hist_record_locked 里
 * `now - g_hist_last_t < 60` 才记一点），**不是** interval_s（那是 5s 的
 * 采样间隔）。v1.21.6 误用 interval_s 当针长，导致排行时长只有实际的 1/12。
 * v1.23.1：60s 只是下限——守护忙时实际间隔会拉到 60~150s，固定按 60s
 * 会让排行时长系统性少算约 9%（实测 6.58h vs 墙钟 7.22h）。
 * 改为逐点取真实跨度（与三档时长同一个 helper）。
 */
            for (var i = 0; i < cyclePts.length; i++) {
                var p = cyclePts[i];
                var fg = (p.length > 2 ? p[2] : -1);
                if (fg < 0 || fg >= pkgs.length) continue;
                var scr = (p.length > 3 ? p[3] : -1);
                if (scr !== 1 && scr !== 0) continue;
                if ((p.length > 4 ? p[4] : 0) === 1) continue;   /* 说明：充电期不计 */
                /* 说明：v1.26.0：插着电但没在充（chg_state=已充满/插电未充电）也不是放电，
 * 功率同样不指向电池放电。按 plg 标记剔除，避免「插着充电器」的时段
 * 混进耗电排行。旧 dump 无 plg（-1）时保持原行为。
 */
                if ((p.length > 9 ? p[9] : -1) === 1) continue;
                var pkg = pkgs[fg];
                if (!pkg || pkg.indexOf('.') < 0) continue;
                var mw = (p.length > 5 ? p[5] : 0) || 0;
                var bt = (p.length > 6 ? p[6] : 0) || 0;
                var o = out[pkg] || (out[pkg] = {
                    all: { ms: 0, mwSum: 0, n: 0, tSum: 0, tn: 0, tMax: 0 },
                    on: { ms: 0, mwSum: 0, n: 0, tSum: 0, tn: 0, tMax: 0 },
                    off: { ms: 0, mwSum: 0, n: 0, tSum: 0, tn: 0, tMax: 0 },
                    touch: { ms: 0, mwSum: 0, n: 0, tSum: 0, tn: 0, tMax: 0 }
                });
                /* 说明：同一针计入「全部」，以及它所属的具体场景桶。
 * v1.22.0：hist 第9位 touch（1=触摸 / 0=亮屏未触摸 / -1=息屏或未知）
 */
                var tou = (p.length > 8 ? p[8] : -1);
                var buckets = [o.all, scr === 1 ? o.on : o.off];
                if (scr === 1 && tou === 1) buckets.push(o.touch);
                var stepMs = histStepMs(cyclePts, i);
                buckets.forEach(function (b) {
                    b.ms += stepMs;
                    if (mw > 0) { b.mwSum += mw; b.n += 1; }
                    if (bt > 0) { b.tSum += bt; b.tn += 1; if (bt > b.tMax) b.tMax = bt; }
                });
            }
            return out;
    }

    /* 说明：公开耗电领域接口：配置页只读取最近放电周期、全部场景时长。 */
    CP.BatteryUsage = Object.freeze({
        splitCycles: splitCycles,
        aggregateApps: aggregateApps,
        currentAppTimes: function (prof) {
            var hist = prof && Array.isArray(prof.hist) && prof.hist.length >= 2 ? prof.hist : null;
            var cycles = splitCycles(hist).cycles;
            var last = cycles.length ? cycles[cycles.length - 1] : null;
            var data = aggregateApps(prof, last ? hist.slice(last.s, last.e) : []);
            var times = {};
            Object.keys(data).forEach(function (pkg) { times[pkg] = data[pkg].all.ms; });
            return times;
        }
    });

    CP.BatteryPage = function () {
        var scope = CP.usePageScope(), generation = useRef(0), readController = useRef(null);
        var _p = useState(null), prof = _p[0], setProf = _p[1];
        /* 说明：effect 依赖为 []，闭包里拿不到最新 prof；用 ref 镜像供异步回调读取。 */
        var profRef = useRef(null);
        profRef.current = prof;
        var _l = useState(true), loading = _l[0], setLoading = _l[1];
        var _nm = useState(0), nameTick = _nm[0], setNameTick = _nm[1];
        /* 说明：v1.26.3：图标存在性/失败状态由 IconExtractor 统一持有（含 localStorage 持久化），
 * 这里只留一个 tick，探针回来后触发重渲染。
 */
        var _it = useState(0), iconTick = _it[0], setIconTick = _it[1];
        /* 说明：v1.26.0：删除「已使用时长三口径」的残余状态（dis/full/plug）。
 * 那三个口径原本既喂「已使用时长」卡（v1.23.3 已删），又喂应用排行的统计窗口；
 * 卡没了之后只剩排行在用，而排行按充电锚点取窗口是错的——见下方 appScrData 注释。
 * 现在排行固定用「选中放电周期」，不再有口径状态。
 */
        /* 说明：v1.18.0 电量曲线放电周期切分 + 单点悬浮详情 */
        var _cy = useState(-1), cycleSel = _cy[0], setCycleSel = _cy[1]; /* 说明：-1=当前（最近拔电至今） */
        var _hv = useState(null), hoverPt = _hv[0], setHoverPt = _hv[1];  /* 说明：悬浮点索引 */
        /* 说明：v1.19.0 卡片二级入口（评价问题4：能"看"也能"查"）：
 * null=收起 | 'pwr'=平均功耗分时段功率曲线 | 'standby'=待机息屏段明细
 */
        var _dr = useState(null), drill = _dr[0], setDrill = _dr[1];
        /* 说明：v1.20.0 需求2/3/5：曲线图例开关（bt/ct=温度线，on/off=亮息屏段） */
        /* 说明：v1.20.0 需求2/3/5：曲线图例开关（bt/ct=温度线，on/off=亮息屏段）
 * v1.21.1：新增 smooth=CPU 温度平滑开关（默认开）
 */
        var _lg = useState({ bt: true, ct: true, on: true, off: true, smooth: true });
        var legend = _lg[0], setLegend = _lg[1];
        /* 说明：v1.21.2 需求1-1：长按应用条目弹出的详情浮层（完整名称 + 完整包名） */
        var _ps = useState(null), pkgSheet = _ps[0], setPkgSheet = _ps[1];
        /* 说明：v1.21.4：周期选择浮层开关 + 已删除（本地隐藏）周期起点时间戳集合。
 * hist 是环形缓冲，C 侧无法删单段，故"删除"实现为前端可见性过滤，
 * 并落盘到 cycle_hidden.txt，刷新/重装后仍生效。
 */
        var _cs = useState(false), cycSheet = _cs[0], setCycSheet = _cs[1];
        var _hd = useState([]), hiddenCycles = _hd[0], setHiddenCycles = _hd[1];
        /* 说明：v1.22.0：应用排行场景四档——全部 / 亮屏 / 触摸 / 息屏。
 * 数据源：hist 第4位=屏幕状态（1亮/0息），第9位=触摸标记（1触摸/0亮屏未触摸/-1息屏）。
 * v1.26.0：统计窗口改为「选中放电周期」（不再是充电锚点口径）。
 * 默认「全部」——先看总量，再按需钻到具体场景。
 */
        var _as = useState('all'), appScr = _as[0], setAppScr = _as[1];
        /* 说明：v1.26.0：排行排序方式——power=按功耗（平均功率）/ time=按时间。
 * 入口是排行卡右上角的小时钟图标：亮（橙）=按时间，灰=按功耗。
 * v1.26.1：默认改为 time（时钟默认开启，图标橙亮）。
 * v1.26.2：power 口径由「能量代理 功率×时长」改为「平均功率」本身——
 * 关掉时钟后真正的功耗最高者排最前，与行内 W 列可逐条核对。
 */
        var _sb = useState('time'), sortBy = _sb[0], setSortBy = _sb[1];
        /* 说明：v1.34.0：平均功耗 / 理论续航默认收起；充电曲线在充电时自动展开。
 * 平均功耗收起态保留整机亮屏一行，并常显整机平均与平均耗电时长；展开后恢复四行明细。
 */
        var _po = useState(false), pwrOpen = _po[0], setPwrOpen = _po[1];
        var _eo = useState(false), etaOpen = _eo[0], setEtaOpen = _eo[1];
        var _co = useState(false), chgOpen = _co[0], setChgOpen = _co[1];
        var _cp = useState(null), chgPick = _cp[0], setChgPick = _cp[1];
        var chgHideTimer = useRef(null);
        /* 说明：v1.35.0：充电统计卡默认只展示「充入电量 / 充电时长」，其余统计与充放对照收起。 */
        var _cso = useState(false), chgStatsOpen = _cso[0], setChgStatsOpen = _cso[1];

        var _err = useState(''), loadError = _err[0], setLoadError = _err[1];
        /* 说明：曲线数据采用可中断更新，导航改选可优先提交；这不是独立线程。 */
        var renderTransition = React.useTransition(), renderPending = renderTransition[0], startRender = renderTransition[1];
        CP.usePageLoading((loading && !prof && !loadError) || renderPending);
        var loadingRef=useRef(false);
        var load = async function (force) {
            if (!scope.isActive() || loadingRef.current) return;
            loadingRef.current = true;
            var revision = generation.current, controller = new AbortController();
            readController.current = controller;
            try {
                var next = await KsuService.readProfile('battery', { signal: controller.signal, cache: !force, force: !!force });
                if (scope.isActive() && revision === generation.current) startRender(function () { if (scope.isActive() && revision === generation.current) { setProf(next); setLoadError(''); } });
            } catch (e) {
                if (scope.isActive() && revision === generation.current) setLoadError(e.message || '耗电数据读取失败');
            } finally {
                if (readController.current === controller) { loadingRef.current = false; readController.current = null; }
                if (scope.isActive() && revision === generation.current) setLoading(false);
            }
        };
        /* 说明：v1.21.4：读取已删除周期列表（文件不存在/为空都视为「无」）。
         * 15 秒内复用结果——这是每次切回都会跑的同步 sh 调用。 */
        var hiddenAt = useRef(0);
        var loadHidden = async function () {
            if (Date.now() - hiddenAt.current < 15000) return;
            hiddenAt.current = Date.now();
            var revision = generation.current;
            var r = await KsuService.exec('cat ' + HIDDEN_PATH + ' 2>/dev/null');
            if (!scope.isActive() || revision !== generation.current) return;
            var txt = (r.stdout || r.output || '').trim();
            if (!txt) { setHiddenCycles(previous => previous.length ? [] : previous); return; }
            var arr = [];
            txt.split(/[,\s]+/).forEach(function (s) {
                var n = parseInt(s, 10);
                if (!isNaN(n) && n > 0 && arr.indexOf(n) < 0) arr.push(n);
            });
            setHiddenCycles(previous => previous.join() === arr.join() ? previous : arr);
        };
        /* 说明：v1.21.4：落盘（写失败不阻断交互，下次进入页面会回读真实状态） */
        var saveHidden = function (arr) {
            setHiddenCycles(arr);
            var body = arr.join(',');
            KsuService.exec('printf %s "' + body + '" > ' + HIDDEN_PATH + ' 2>/dev/null');
        };
        CP.usePageTask(function () {
            load();
            /* 说明：v1.21.4：进页面回读已删除周期列表。之前漏了这一步——文件写进去了
 * 但刷新后不生效，删除等于白删（v1.21.6 补齐）。
 */
            loadHidden();
            /* 说明：v1.26.3：图标白名单探一次（与配置页共用一个 exec）。
 * 不探的话排行与长按浮层只能先渲染色块，等 img 解码/404 回来才换图标——
 * 那正是"点开应用时图标闪一下"的来源。
 */
            var aliveIcon = true;
            if (CP.IconExtractor && typeof CP.IconExtractor.probeOnce === 'function') {
                CP.IconExtractor.probeOnce().then(function () {
                    if (!aliveIcon) return;
                    if (Object.keys(CP.IconExtractor.known).length) setIconTick(function (n) { return n + 1; });
                });
            }
            /* 说明：定期刷新也推到绘制之后，避免在用户操作的帧上同步执行。 */
            var t = setInterval(function () {
                if (!scope.isActive()) return;
                CP.afterPaint(function () { if (scope.isActive()) load(true); });
            }, 60000);
            return function () {
                aliveIcon = false; clearInterval(t); generation.current++;
                if (readController.current) readController.current.abort();
                readController.current = null; loadingRef.current = false;
            };
        }, []);

        /* 说明：v1.21.6：浮层打开时锁住页面滚动。
 * 原来浮层盖住屏幕后，手指在透明区继续滑动会带着底下的排行榜一起滚
 * （用户反馈"没定住"）。这里在任一浮层打开期间把 body 的 overflow
 * 设为 hidden，关闭时恢复原值。
 */
        CP.usePageTask(function () {
            if (!cycSheet && !pkgSheet) return;
            var prev = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            return function () { document.body.style.overflow = prev; };
        }, [cycSheet, pkgSheet]);

        /* 说明：应用名异步解析（与画像页同款） */
        var apps = useMemo(function () { return prof && prof.apps ? prof.apps.filter(function (a) {
            return a.pkg && a.pkg.indexOf('.') >= 0;
        }) : []; }, [prof]);

        /* 说明：图标提取必须等 prof 真正到齐之后再提交。
         * 早期把 launch 放在数据加载的 effect 里（依赖 []），那一刻 prof 还是 null，
         * 取到的包名列表是空的，launch 从未执行——所以本页所有图标都只能靠应用页顺带提取。
         * 这就是「耗电页支付宝没图标，去应用页搜一下就有了」的原因。
         * 现在改为依赖 apps 的包名签名，数据一到就提交，且只在签名变化时重提。 */
        var appsKey = useMemo(function () {
            return apps.length ? apps.map(function (a) { return a.pkg; }).join(',') : '';
        }, [apps]);
        CP.usePageTask(function () {
            if (!appsKey || !CP.IconExtractor || typeof CP.IconExtractor.launch !== 'function') return;
            /* 说明：v2.5.4：预热期不提交图标提取。
             * IconExtractor 每批要 fork 一次 app_process64 起虚拟机，而 ksu.exec 是同步桥接，
             * 一轮提取会把主线程切成十几段卡顿。启动预热时这正好发生在首屏，
             * 表现为「刚进来点什么都没反应」。真正进入本页（warming 结束，usePageTask 重跑）再提交。 */
            if (scope.warming) return;
            var pkgs = appsKey.split(',');
            /* 说明：提交全部包。早期只提交前 40 个，一个放电周期若有 45 个应用，
             * 排在 41~45 的就永远没有图标——支付宝恰好落在这个区间被漏掉。
             * 队列本身有上限且按 FIFO 消化，一次提交全部没有副作用。 */
            CP.IconExtractor.launch(pkgs, {});
        }, [appsKey]);
        CP.usePageTask(function () {
            if (!apps.length) return;
            var pend = apps.filter(function (a) { return !NameResolver.cache[a.pkg]; });
            if (!pend.length) return;
            /* 说明：分批解析，每批 6 个、间隔 80ms。原来用一次 Promise.all 把几十个包
             * 同时入队，等于在切页那一帧制造一次成规模的解析风暴——与应用页早期的问题同源。 */
            var alive = true, controller = new AbortController(), timer = null, idx = 0;
            var CHUNK = 6;
            var step = function () {
                if (!alive || idx >= pend.length) return;
                var chunk = pend.slice(idx, idx + CHUNK);
                idx += CHUNK;
                Promise.all(chunk.map(function (a) {
                    return NameResolver.resolve(a.pkg, { signal: controller.signal }).catch(function () { return null; });
                })).then(function () {
                    if (!alive) return;
                    setNameTick(function (n) { return n + 1; });
                    timer = setTimeout(step, 80);
                });
            };
            step();
            return function () { alive = false; clearTimeout(timer); controller.abort(); };
        }, [prof]);

        /* 说明：指标计算（v1.26.0：run_ms 随三口径链退役——它的唯一消费方 disMs 已删） */
        var hist = (prof && prof.hist && prof.hist.length >= 2) ? prof.hist : null;
        /* 说明：v1.18.0 放电周期切分（v1.27.0 修正：插电已满也属插电，认真实拔电沿）
 * 优先用 hist 第5位充放状态 + 第10位插电标记（v15）；旧数据用 cap 差分兜底。
 * v1.27.0：夜间充满 100% 后继续插着充电器到早上时，chg=0 但 plg=1。
 * 旧实现只看 chg 1→0 就开启新周期，把整夜插着电的 5~6 小时全算进「本次放电」。
 * 现把「充电中或插着电」（chg===1 || plg===1）统一视为外部供电态：
 * 只有真正拔掉充电器（供电态 1→0）才开启新周期。无拔电沿时整段兜底。
 */
        var cycleData = useMemo(function () { return CP.BatteryUsage.splitCycles(hist); }, [hist]);
        var ptChg = cycleData.charging, cycles = cycleData.cycles;
        /* 说明：v1.21.4：滤掉已删除（本地隐藏）的周期，以起点时间戳为身份
 * （hist 是环形缓冲，索引会随采样漂移，时间戳稳定）；
 * 至少保留最后一根（当前周期），避免删空后图表无内容。
 */
        var visCycles = useMemo(function () {
            var visible = cycles.filter(function (c) { return hiddenCycles.indexOf(hist[c.s][0]) < 0; });
            return visible.length || !cycles.length ? visible : [cycles[cycles.length - 1]];
        }, [cycles, hiddenCycles, hist]);
        var hiddenCount = cycles.length - visCycles.length;
        var selIdx = cycleSel < 0 ? visCycles.length - 1
            : Math.min(cycleSel, visCycles.length - 1);
        var selCycle = visCycles.length ? visCycles[Math.max(selIdx, 0)] : null;
        var cyclePts = useMemo(function () { return selCycle ? hist.slice(selCycle.s, selCycle.e) : []; }, [hist, selCycle]);
        var cycleChg = useMemo(function () { return selCycle ? ptChg.slice(selCycle.s, selCycle.e) : []; }, [ptChg, selCycle]);
        /* 说明：v1.26.0：周期身份（起止索引）。appScrData 的 useMemo 依赖它而不是 cyclePts
 * 数组本身——slice 每帧都产生新数组，直接依赖会让排行聚合每帧重算。
 */
        var cycKey = selCycle ? (selCycle.s + ':' + selCycle.e) : '';
        /* 说明：v1.23.2：旧的 estimateEta（曲线尾部 %/h 外推）已删除——它与三档功耗卡的
 * 功率口径不同源，同一页面能给出互相矛盾的两个数。理论续航改由
 * 下方 cycStats 的功率 + 能量校准推出（见 etaModel）。
 */

        /* 说明：v1.18.1 数据自洽：已使用时长卡展示同周期已耗电量，
 * 续航卡亮出「剩余电量 + 估算速率」——已用/剩余/速率三要素可互相验算，
 * 消除"已用10h+续航10h但电量还有77%"的口径矛盾感。
 */
        /* 说明：v1.23.1：累计掉电改为「逐点下降累加」（充电与插电点跳过）。
 * 原来取周期首尾电量差，周期内只要充过一次电，回升的电量就把消耗抵掉了，
 * 甚至能算出 0%。
 */
        var cycDropPct = useMemo(function () {
            var cycDropPct = 0, cycPrevCap = -1;
        for (var di = 0; di < cyclePts.length; di++) {
            var dp = cyclePts[di];
            if ((dp.length > 4 ? dp[4] : 0) === 1 || (dp.length > 9 ? dp[9] : -1) === 1) continue;
            var dcap = dp[1];
            if (cycPrevCap >= 0 && dcap < cycPrevCap) cycDropPct += cycPrevCap - dcap;
            cycPrevCap = dcap;
        }
            return cycDropPct;
        }, [cyclePts]);
        var cycDrop = cycDropPct;
        /* 说明：v1.23.1：待机耗电卡在 v1.23.0 已并入三档卡，这里只留下它的派生量——
 * 注意 standbyMah 在下面才赋值，原写法在赋值前就参与计算，算出的是 NaN
 * （JS var 提升），已随卡片一并删除，避免后续误用。
 */

        /* 说明：v1.23.0：周期级三档功耗 + 息屏段（统一数据源）
 * 用户反馈：待机耗电、平均功耗、息屏明细本质都是「三档功耗」的派生，
 * 分开显示既重复又容易对不上（待机耗电是分摊推算，息屏功耗是实测均值，
 * 同一时段能差 7%+）。这里统一从「选中周期的点」派生：
 * · 触摸亮屏 / 静止亮屏 / 息屏 三档功率均值
 * · 亮屏（静止 + 触摸，时长相加、功率按时长加权）
 * · 整机平均（三档加权）+ 本次耗电时长（= 三档时长合计）
 * · 息屏段明细（连续 scr=0 且放电的段：起止/时长/掉电/均功率）
 * 功率：当前周期优先用 C 侧 bucket_pwr_mw（5s 采样，样本多）；
 * 历史周期只能从 hist 现算（60s 一针），UI 标注口径差异。
 * v1.23.3：**时长全部改由 hist 时间戳推**，C 侧 bucket_ms 停用。
 * 根因：C 侧每采一次固定加 interval*1000（5s），而实际采样周期被 doze 与
 * sysfs 读取拖到 6~8s——实测一周期墙钟 10.43h，bucket_ms 只记到 8.57h，
 * 其中息屏 4.65h 只记到 2.90h（少 38%）。用户反馈的「耗电息屏时间不准确」
 * 就是这个。现在每点跨度 = 到下一针的墙钟差（>300s 视为停机夹断），
 * 跨度对半记给「本点状态」与「下点状态」（切换发生在两点之间，对半不偏向
 * 任何一侧），充电那半直接丢弃。于是：
 * 三档时长合计 == 本次耗电时长 == 周期内墙钟放电时长，
 * 与理论续航同源，不会再出现两个互相矛盾的时间。
 */
        var cycStats = useMemo(function () {
            var mk = function () { return { ms: 0, wsum: 0, wms: 0, n: 0, avg: 0, pts: [] }; };
            var out = {
                /* 说明：pts=[[功率mW, 该针跨度ms], ...]，供理论续航取时间加权 25%/75% 分位 */
                touch: mk(), idle: mk(), off: mk(), on: mk(), all: mk(),
                segs: [],
                src: 'hist'
            };
            if (!cyclePts.length) return out;

            /* 说明：单点状态：touch / idle / off / chg（v1.27.0：充电或插电未充侧均不参与放电统计） */
            var kindOf = function (p) {
                if ((p.length > 4 ? p[4] : 0) === 1 || (p.length > 9 ? p[9] : -1) === 1) return 'chg';
                var scr = (p.length > 3 ? p[3] : -1);
                if (scr === 0) return 'off';
                if (scr === 1) return ((p.length > 8 ? p[8] : -1) === 1) ? 'touch' : 'idle';
                return null;                    /* 说明：屏幕状态未知：既不计时长也不计功率 */
            };
            var addPart = function (p, kind, w) {
                if (!kind || kind === 'chg' || !(w > 0)) return;
                var b = out[kind];
                b.ms += w;
                var mw = (p.length > 5 ? p[5] : 0) || 0;
                if (mw > 0) { b.wsum += mw * w; b.wms += w; b.n += 1; b.pts.push([mw, w]); }
            };

            /* 说明：1) 逐段计时：每段跨度对半分给两端状态（末点按标称 60s 记给自己） */
            for (var i = 0; i < cyclePts.length; i++) {
                var p = cyclePts[i];
                var w = histStepMs(cyclePts, i);
                if (i === cyclePts.length - 1) { addPart(p, kindOf(p), w); break; }
                addPart(p, kindOf(p), w / 2);
                addPart(cyclePts[i + 1], kindOf(cyclePts[i + 1]), w / 2);
            }

            /* 说明：2) 息屏段：只收「息屏 + 放电」的连续点（v1.23.1 起）；
 * 时长用墙钟，功率按时间加权（原来是点数平均，采样间隔不均时会偏）。
 */
            function pushOffSeg(a, b2) {
                if (b2 <= a) return;
                var drop = 0, sum = 0, wms = 0, prevCap = -1, k;
                for (k = a; k <= b2; k++) {
                    var kp = cyclePts[k];
                    var kmw = (kp.length > 5 ? kp[5] : 0) || 0;
                    var kcap = kp[1];
                    if (prevCap >= 0 && kcap < prevCap) drop += prevCap - kcap;
                    prevCap = kcap;
                    var kw = histStepMs(cyclePts, k);
                    if (kmw > 0) { sum += kmw * kw; wms += kw; }
                }
                out.segs.push({
                    t0: cyclePts[a][0], t1: cyclePts[b2][0],
                    ms: (cyclePts[b2][0] - cyclePts[a][0]) * 1000,
                    capDrop: drop, mw: wms > 0 ? sum / wms : 0
                });
            }
            var segSt = -1, j;
            for (j = 0; j < cyclePts.length; j++) {
                var sp = cyclePts[j];
                var offNow = ((sp.length > 3 ? sp[3] : -1) === 0) &&
                    ((sp.length > 4 ? sp[4] : 0) !== 1) &&
                    ((sp.length > 9 ? sp[9] : -1) !== 1);
                if (offNow) { if (segSt < 0) segSt = j; }
                else if (segSt >= 0) { pushOffSeg(segSt, j - 1); segSt = -1; }
            }
            if (segSt >= 0) pushOffSeg(segSt, cyclePts.length - 1);

            /* 说明：3) 当前周期：功率用 C 侧 5s 采样均值覆盖（样本多、更稳），时长仍用 hist。
 * 注意 cOf() 返回的**已经是均值**：只能写进 avg，不能再进 wsum/wms 求平均，
 * 否则会重演 v1.23.0 的二次平均（2366 mW ÷ 26 点 = 91 mW，三档全显 0.1 W）。
 */
            var isCur = (cycleSel < 0);
            var bp = (prof && prof.bucket_pwr_mw) || {};
            var cOf = function (k) { return (bp[k] && bp[k].n > 0) ? (bp[k].avg || 0) : 0; };
            if (isCur && (cOf('on_touch') > 0 || cOf('on_idle') > 0 || cOf('off') > 0)) {
                out.src = 'C';
                [['touch', 'on_touch'], ['idle', 'on_idle'], ['off', 'off']].forEach(function (pair) {
                    var v = cOf(pair[1]);
                    if (v > 0) { out[pair[0]].avg = v; out[pair[0]].n = Math.max(out[pair[0]].n, 1); }
                });
            }

            /* 说明：4) 均值：有 C 覆盖的用 C，其余按时间加权（wsum/wms）；C 侧没有样本的档
 * 保留 hist 现算值（不拿 0 充数）。
 */
            ['touch', 'idle', 'off'].forEach(function (k) {
                if (!(out[k].avg > 0) && out[k].wms > 0) out[k].avg = out[k].wsum / out[k].wms;
            });

            /* 说明：5) 亮屏 = 静止 + 触摸：时长直接相加，功率按时长加权 */
            out.on.ms = out.idle.ms + out.touch.ms;
            out.on.avg = out.on.ms > 0
                ? (out.idle.avg * out.idle.ms + out.touch.avg * out.touch.ms) / out.on.ms : 0;
            out.on.pts = out.idle.pts.concat(out.touch.pts);
            out.on.wms = out.idle.wms + out.touch.wms;
            out.on.n = out.idle.n + out.touch.n;

            /* 说明：6) 整机平均：三档按时长加权；时长 = 三档之和 = 本次耗电时长。
 * 只对「有功率样本」的档加权，避免某档缺功率时被 0 拉低。
 */
            out.all.ms = out.touch.ms + out.idle.ms + out.off.ms;
            out.all.pts = out.touch.pts.concat(out.idle.pts, out.off.pts);
            var wsum = 0, wms = 0;
            [out.touch, out.idle, out.off].forEach(function (b) {
                if (b.avg > 0 && b.ms > 0) { wsum += b.avg * b.ms; wms += b.ms; }
            });
            out.all.avg = wms > 0 ? wsum / wms : 0;
            return out;
        }, [cyclePts, prof, cycleSel]);
        /* 说明：v1.23.2 理论续航（四口径 + 区间）
 * 与三档功耗同一数据源（cycStats），所以「功率 × 电量」能互相验算：
 * E_rem = 周期末电量% × 每 1% 能量
 * 每 1% 能量 = 周期放电能量 ÷ 周期掉电%（实测校准；掉电不足退回标称容量）
 * 区间 = 该档功率的时间加权 25%/75% 分位（见 etaPredict）。
 */
        var etaModel = useMemo(function () {
            var capNow = cyclePts.length ? cyclePts[cyclePts.length - 1][1] : 0;
            var epp = energyPerPct(cyclePts, cycDropPct, prof ? prof.batt_full_ua : 0);
            var m = etaPredict(cycStats, capNow, epp.v);
            m.src = epp.src;          /* 说明：'cal' 实测校准 / 'cap' 标称容量 / null 无数据 */
            m.mWhPerPct = epp.v;
            return m;
        }, [cyclePts, cycDropPct, prof, cycStats]);
        /* 说明：功率序列：hist 第6元素（mw），画分时段功率曲线（整机平均 › 看曲线）
 * v1.23.1：跟随选中周期。原来遍历整个 hist，切周期后曲线不变——
 * 与「三档功耗」同一张卡的两个入口，窗口必须一致。
 * v1.23.3：每点带 kind（touch/idle/off），曲线按档位分段着色；
 * 充电点 kind 无意义（画成灰段）。
 */
        var pwrSeries = useMemo(function () {
            var pwrSeries = [];
        for (var pi = 0; pi < cyclePts.length; pi++) {
            var pp = cyclePts[pi];
            var pmw = (pp.length > 5 ? pp[5] : 0) || 0;
            if (pmw > 0) {
                var pscr = (pp.length > 3 ? pp[3] : -1);
                var ptou = (pp.length > 8 ? pp[8] : -1);
                var pplg = (pp.length > 9 ? pp[9] : -1);
                pwrSeries.push({
                    t: pp[0], mw: pmw, chg: cycleChg[pi], plg: pplg,
                    kind: pscr === 0 ? 'off' : (pscr === 1 ? (ptou === 1 ? 'touch' : 'idle') : 'off')
                });
            }
        }
            return pwrSeries;
        }, [cyclePts, cycleChg]);
        /* 说明：v1.23.0：息屏段改由 cycStats.segs 提供（跟随选中周期），
 * 原来这里遍历整个 hist，切周期后明细不变——用户反馈的正是这个问题。
 */
        var offSegs = cycStats.segs;

        /* 说明：v1.32.0 充电会话（跟随整条 hist，不跟随选中放电周期）
 * 放电周期以「拔电沿」为边界，一次充电正好跨在这两个放电周期之间——
 * 若把充电统计绑在选中周期上，切到旧周期只会在周期尾部看到半段充电（甚至没有），
 * 统计就变成"某个周期的部分充电"，读起来没有意义。
 * 所以充电会话取整条 hist 的最后一次充电（与放电周期的选中状态解耦），
 * 卡片标题写明「最近一次 / 进行中」，避免与上方「本次放电 · 历史周期」混为一谈。
 */
        var chgSess = useMemo(function () { return chgSessions(hist); }, [hist]);
        var chgFirst = chgSess.last ? chgSess.last.t0 : null;
        var cancelChargeHide = function () {
            if (chgHideTimer.current !== null) clearTimeout(chgHideTimer.current);
            chgHideTimer.current = null;
        };
        var clearChargePoint = function () {
            cancelChargeHide();
            setChgPick(null);
        };
        var chgSelected = (chgOpen && chgSess.last && chgSess.last.pts.length >= 2 && chgPick && chgPick.start === chgFirst)
            ? chgSess.last.pts.find(function (p) { return p.t === chgPick.t; }) : null;
        var selectChargePoint = function (p) {
            cancelChargeHide();
            setChgPick(function (prev) {
                if (!p) return null;
                return prev && prev.start === chgFirst && prev.t === p.t ? prev : { start: chgFirst, t: p.t };
            });
        };
        var hideChargeLater = function () {
            if (!chgSelected) return;
            cancelChargeHide();
            chgHideTimer.current = setTimeout(clearChargePoint, POINT_HIDE_MS);
        };
        CP.usePageTask(function () { return function () {
            cancelChargeHide();
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        }; }, []);
        useEffect(function () {
            if (!chgOpen || (chgPick && !chgSelected)) clearChargePoint();
        }, [chgOpen, chgPick, chgSelected]);

        /* 说明：v1.20.0 曲线增强数据（需求2/3）
 * 累计掉电：见上面 cycDropPct（v1.23.1 起按逐点下降累加，不再重算）。
 * 温度极值：选中周期内 hist bt/ct 的最大值（需求3-1）。
 */
        var maxima = useMemo(function () {
            var cycBtMax = 0, cycCtMax = 0;
        for (var ci = 0; ci < cyclePts.length; ci++) {
            var cbt = (cyclePts[ci].length > 6 ? cyclePts[ci][6] : 0) || 0;
            var cct = (cyclePts[ci].length > 7 ? cyclePts[ci][7] : 0) || 0;
            if (cbt > cycBtMax) cycBtMax = cbt;
            if (cct > cycCtMax) cycCtMax = cct;
        }
            return [cycBtMax, cycCtMax];
        }, [cyclePts]);
        var cycBtMax = maxima[0], cycCtMax = maxima[1];
        /* 说明：温度状态提示（需求3-3）占位：见实时区之后（依赖 battTCur/cpuTCur） */

        /* 说明：v1.17.0 实时与温度（画像 dump v12 瞬时值）：功率带符号（充正/放负） */
        var pwrNowMw = prof ? (prof.pwr_now_mw || 0) : 0;
        /* 说明：v1.25.0：当前充放状态以 C 侧 chg_state 为准（0 放电 / 1 充电 / 2 已充满 / 3 插电未充电）。
 * 旧 dump（v14 及更早）没有该字段 → 退回按 pwr_now_mw 正负猜（v1.24.x 行为）。
 * 有 chg_state 时不再用功率正负当状态：100% 时电流接近 0，正负本身不可靠。
 */
        var chgState = (prof && typeof prof.chg_state === 'number') ? prof.chg_state : null;
        /* 说明：v1.33.0：当前是否真的在充电。优先用 C 侧 chg_state（1=充电）；
 * 旧 dump 无该字段时退回「最后一次充电会话末针 chg=1」。
 * 充电曲线据此优先展开，离开充电态自动收起；用户手动收起后同一充电过程不再强制展开。
 */
        var chgTailKind = (chgSess.last && chgSess.last.ongoing && hist) ? ptChgKind(hist[chgSess.last.e]) : null;
        var chargingNow = (chgState === 1) || (chgState === null && chgTailKind === 'chg');
        useEffect(function () {
            setChgOpen(!!chargingNow);
        }, [chargingNow]);
        var battTCur = prof ? (prof.batt_t_cur_c || 0) : 0;
        var cpuTCur = prof ? (prof.cpu_t_cur_c || 0) : 0;
        /* 说明：v1.20.0 需求3-3：温度状态文字提示，阈值为常用经验值 */
        var btState = battTCur <= 0 ? null : (battTCur >= 42 ? '过热' : (battTCur >= 38 ? '偏高' : '正常'));
        var ctState = cpuTCur <= 0 ? null : (cpuTCur > 60 ? '过热' : (cpuTCur >= 50 ? '偏高' : '正常'));
        /* 说明：v1.26.0：删掉「已使用时长三口径」整条链（nowS/fullAt/plugAt/disMs/unplugAt/
 * usedStartS/usedRaw/usedFallback）。
 * 这条链 v1.23.3 就已经没有展示位（卡片删了），只剩排行在用；
 * 而排行按「插电后 / 充满后」取窗口本身就是错的——充电时功率是**充进电池**的
 * 正数，把那段纳入统计窗口等于把充电当成耗电。排行现在固定用选中放电周期
 * （见 appScrData），三口径连同它的兜底分支一起退役。
 */
        /* 说明：v1.17.0 三档功耗（自画像页迁入）：触摸亮屏/静止亮屏/息屏 平均功率
 * v1.23.1：原「待机耗电 = 放电电量 × 息屏能量占比」的整条链（bkPwr/pwrOf/
 * bm/bp/avgOf/eOn/eOff/eTot/offShare/standbyMah）随卡片合并一并删除——
 * 它算出来的 standbyMah 只喂给上面那个 NaN 表达式，留着是纯隐患。
 */

        /* 说明：v1.21.7 应用排行：场景细分；v1.26.0 窗口改为「选中放电周期」
 * 窗口 = 选中周期 cyclePts（与三档功耗 / 理论续航同一个窗口，全页一条口径），
 * 在该窗口内按 hist 的屏幕状态分桶：
 * all  = 全部（亮屏 + 息屏）
 * on   = 亮屏
 * off  = 息屏
 * touch= 触摸（v1.22.0 起 hist 第 9 位有触摸标记，可用）
 * 口径与 C 侧 apps 一致：只统计放电期（chg=1 跳过）、包名含 '.'。
 * 
 * v1.26.0 为什么删掉「统计范围（拔电后/插电后/充满后）」：
 * 那两个充电锚点口径把**充电时段**也算进窗口，而充电时 mw 是充进电池的
 * 正数功率，统计「耗电」在物理上就不成立（用户原话：「我充电能统计耗电吗，
 * 那时功率不是往电池充电的正数功率吗」）。原实现只是把 chg=1 的针跳过，
 * 但「插电未充电 / 已充满插着电」的针 chg=0，照样被当成放电计入，
 * 窗口里大部分是插着电的时间——排行数值因此既不是耗电也不是时长。
 * 现在窗口固定为放电周期（起点=拔电沿），充电与插电时段天然落在窗口外，
 * 不需要用户再选口径。
 */
        var appScrData = useMemo(function () {
            return CP.BatteryUsage.aggregateApps(prof, cyclePts);
        }, [prof, cycKey]);

        /* 说明：当前场景下的排行：sortBy=power 按平均功率 pw 降序（功耗最高优先），
 * time 按时长降序。
 * v1.26.2：power 原来按能量代理 pw×ms 降序，被时长主导——实测关掉时钟后
 * 前 8 名与按时间完全同序（5.97 W 的短时应用排在第 10），等于「按功耗」
 * 没生效。现改为按 pw 本身降序，与行内显示的 W 列同一口径、可直接核对；
 * 同功率（差 < 0.01 W）时按能量代理兜底，再按时长，避免顺序随机。
 */
        var scList = useMemo(function () {
            var arr = [];
            for (var pkg in appScrData) {
                var s = appScrData[pkg][appScr];
                if (!s || s.ms <= 0) continue;
                arr.push({
                    pkg: pkg,
                    ms: s.ms,
                    pw: s.n > 0 ? s.mwSum / s.n : 0,
                    pwn: s.n,
                    tavg: s.tn > 0 ? s.tSum / s.tn : 0,
                    tmax: s.tMax
                });
            }
            arr.sort(function (a, b) {
                if (sortBy === 'time') {
                    /* 说明：时长降序；同长度时按功耗（能量代理）兜底，避免顺序随机 */
                    var dt = (b.ms || 0) - (a.ms || 0);
                    if (dt) return dt;
                    return (b.pw || 0) * (b.ms || 0) - (a.pw || 0) * (a.ms || 0);
                }
                /* 说明：power：平均功率降序。浮点比较留 0.01 W 容差，
 * 容差内按能量代理、再按时长兜底，避免同值抖动。
 */
                var dp = (b.pw || 0) - (a.pw || 0);
                if (Math.abs(dp) > 0.01) return dp;
                var de = (b.pw || 0) * (b.ms || 0) - (a.pw || 0) * (a.ms || 0);
                if (de) return de;
                return (b.ms || 0) - (a.ms || 0);
            });
            return arr;
        }, [appScrData, appScr, sortBy]);

        /* 说明：排行默认只渲染前 20 条。一个放电周期可能有几十个应用，
         * 全量渲染会让每次切回本页都构建上百个 DOM 节点（每行含图标与多处文本），
         * 这是与应用页「一次渲染太多行」同类型的问题。 */
        var _al = useState(20), appLimit = _al[0], setAppLimit = _al[1];
        useEffect(function () { setAppLimit(20); }, [appScr, sortBy, prof]);
        var scVisible = useMemo(function () { return scList.slice(0, appLimit); }, [scList, appLimit]);

        /* 说明：v1.19.0：iconBg=图标彩色底（信息类型区分），onClick=卡片二级入口，
 * hint=可点提示（如"看曲线 ›"）——评价问题2/4
 */
        var card = function (title, value, sub, iconName, iconBg, onClick, hint) {
            var kids = [
                h('div', { key: 'hd', className: 'flex items-center justify-between gap-1' }, [
                    h('div', { className: 'flex items-center gap-1.5 min-w-0' },
                        iconName ? h('span', { className: 'p-1 rounded-md shrink-0 ' +
                            (iconBg || 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-300') },
                            h(Icon, { name: iconName, className: 'w-3 h-3' })) : null,
                        h('span', { className: 'text-[10px] text-slate-400 font-bold truncate' }, title)),
                    hint ? h('span', { className: 'text-[9px] font-bold text-brand-600 dark:text-brand-400 shrink-0' }, hint) : null
                ]),
                /* 说明：v1.17.0 排版：数值 nowrap（时长/单位不拆行）+ 等宽数字对齐
 * v1.33.0：按字符数自适应字号，避免长数值顶出卡片
 */
                h('div', { key: 'v', className: numSize(value, false) + ' font-black text-slate-800 dark:text-white mt-0.5 leading-tight whitespace-nowrap tabular-nums' }, value),
                /* 说明：v1.21.2 需求1-3：副标题原为 whitespace-nowrap + overflow-hidden + text-ellipsis，
 * 文案稍长就被省略号截断（理论续航的估算规则说明首当其冲）。
 * 改为正常换行，保证模块内所有文字完整展示。
 */
                h('div', { key: 's', className: 'text-[10px] text-slate-400 mt-0.5 leading-snug break-words' }, sub)
            ];
            var cls = 'min-w-0 overflow-hidden rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm text-left w-full' +
                (onClick ? ' active:scale-[0.98] transition-transform cursor-pointer' : '');
            return onClick
                ? h('button', { key: 'c', className: cls, onClick: onClick }, kids)
                : h('div', { key: 'c', className: cls }, kids);
        };
        /* 说明：v1.18.0 核心实时卡：大字号 + 强调底，与次要卡片拉开层级。
 * v1.18.1：加图标 + 充放状态色（放电橙/充电绿），一眼识别当前状态
 */
        var coreCard = function (title, value, sub, iconName, tone) {
            var toneCls = tone === 'dis'
                ? 'border-orange-200/80 dark:border-orange-500/30 bg-gradient-to-br from-orange-50 to-white dark:from-orange-500/10 dark:to-white/5'
                : (tone === 'chg'
                    ? 'border-emerald-200/80 dark:border-emerald-500/30 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-500/10 dark:to-white/5'
                    : 'border-slate-200/70 dark:border-white/10 bg-gradient-to-br from-slate-50 to-white dark:from-white/10 dark:to-white/5');
            var valCls = tone === 'dis' ? 'text-orange-600 dark:text-orange-400'
                : (tone === 'chg' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-white');
            return h('div', { className: 'min-w-0 overflow-hidden rounded-2xl p-3 shadow-sm border ' + toneCls }, [
                h('div', { className: 'flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400 font-bold' },
                    iconName ? h(Icon, { name: iconName, className: 'w-3 h-3 shrink-0' }) : null,
                    h('span', { className: 'truncate' }, title)),
                /* 说明：v1.33.0：实时功率等长数值按字符数降字号 + min-w-0，窄屏不再跑出卡片 */
                h('div', { 'data-core-value': 'true', className: numSize(value, true) + ' font-black mt-0.5 leading-none whitespace-nowrap tabular-nums tracking-tight ' + valCls }, value),
                /* 说明：v1.21.5：副标题原为 whitespace-nowrap——文案一长就直接顶出卡片（用户反馈
 * 「偏高 · 本周期最高 41.8°」跑出边界）。改为可换行兜底 + 文案同步精简，
 * 既不会溢出，正常长度下也不会换行。
 */
                h('div', { className: 'text-[9px] text-slate-400 mt-1 leading-snug break-words' }, sub)
            ]);
        };

        /* 说明：v1.33.0：充电曲线卡片节点。充电时置顶优先展示；不充电时默认收起，
 * 由充电统计卡底部入口展开（展开后出现在充电统计卡下方）。
 */
        var chargeChartNode = null;
        if (chgOpen && chgSess.last) {
            var chgLast = chgSess.last;
            var chgSvg = ChargeChart(chgLast, chgSelected, chgSelected && hist[chgSelected.histIndex],
                prof.hist_pkgs || [], selectChargePoint, hideChargeLater);
            chargeChartNode = h('div', {
                key: 'chgchart',
                'data-charge-card': 'true',
                className: 'rounded-2xl bg-white dark:bg-[#121212] border border-teal-200/70 dark:border-teal-500/25 p-3 shadow-sm'
            }, [
                h('div', { className: 'flex items-center justify-between gap-2 mb-2' }, [
                    h('div', { className: 'flex items-center gap-1.5 min-w-0' }, [
                        h('span', { className: 'p-1 rounded-md shrink-0 bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400' },
                            h(Icon, { name: 'zap', className: 'w-3 h-3' })),
                        h('span', { className: 'text-[10px] text-slate-400 font-bold whitespace-nowrap' }, '充电曲线'),
                        h('span', { className: 'text-[9px] text-slate-400 truncate' },
                            '功率 × 时间 · ' + chgLast.pts.length + ' 点')
                    ]),
                    h('button', {
                        'data-charge-toggle': 'true',
                        onClick: function () { setChgOpen(false); },
                        className: 'shrink-0 text-[9px] font-bold text-teal-600 dark:text-teal-400 px-2 py-1 rounded-md bg-teal-50 dark:bg-teal-500/10 active:opacity-60'
                    }, '收起 ▲')
                ]),
                chgSvg || h('div', { className: 'text-[10px] text-slate-400 py-4 text-center' },
                    '充电采样不足：至少需要 2 个带功率的采样点'),
                h('div', { className: 'flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-[9px] text-slate-400' }, [
                    h('span', { key: 'k1', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#0d9488' } }), '充电中']),
                    h('span', { key: 'k2', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#94a3b8' } }), '已满 / 插电未充']),
                    h('span', { key: 'k3', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#f59e0b' } }), '平均功率']),
                    h('span', { key: 'k4', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#16a34a' } }), '充电百分比'])
                ])
            ]);
        }

        /* 说明：静态图形与统计缓存按数据和可见选项失效；悬浮卡仍按下显示、拖动跟随、松手隐藏。 */
        var dischargeChart = useMemo(function () {
            return cyclePts.length ? BattChart(cyclePts, { chg: cycleChg, pkgs: (prof && prof.hist_pkgs) || [], hover: hoverPt, onHover: setHoverPt, legend: legend }) : null;
        }, [cyclePts, cycleChg, prof, hoverPt, legend]);
        var powerChart = useMemo(function () {
            return drill === 'pwr' && pwrSeries.length ? PwrChart(pwrSeries, { all: cycStats.all.avg, on: cycStats.on.avg, hist: cyclePts }) : null;
        }, [drill, pwrSeries, cycStats, cyclePts]);

        /* 说明：v1.21.1 需求1-4：点击页面空白处关闭浮窗。
 * 只在冒泡阶段处理，且排除图表自身（图表点击会先更新 hover），
 * 避免"刚点曲线就被立刻关掉"。
 */
        return h('div', { className: 'space-y-4',
            onPointerDown: function (e) {
                /* 说明：仅充电图自身的触点不清除充电浮窗，放电仍沿用原有页面行为。 */
                var t = e.target;
                while (t && t !== e.currentTarget && t.tagName !== 'svg') t = t.parentNode;
                var inSvg = t && t !== e.currentTarget && t.tagName === 'svg';
                if (chgPick && (!inSvg || !t.hasAttribute('data-charge-chart'))) clearChargePoint();
                if (!inSvg && hoverPt != null) setHoverPt(null);
            } }, [
            loadError ? h('div', {'data-battery-error':true,role:'alert',className:'p-3 text-[12px] text-amber-600 dark:text-amber-400'}, loadError) : null,
            /* 说明：v1.33.0：充电时充电曲线置顶优先展示；不充电时默认收起（节点为 null）。 */
            chargingNow ? chargeChartNode : null,
            /* 说明：图表区 */
            h('div', { className: 'rounded-3xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-5 shadow-sm' }, [
                h('div', { className: 'flex items-center justify-between mb-2' }, [
                    h('div', { className: 'flex items-center gap-2.5 shrink-0' }, [
                        h('div', { className: 'p-2 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
                            h(Icon, { name: 'activity', className: 'w-4 h-4' })),
                        h('h3', { className: 'font-bold text-[15px] whitespace-nowrap' },
                            cycleSel < 0 ? '本次放电' : '历史放电周期')
                    ]),
                    h('span', { className: 'text-[10px] text-slate-400 font-medium' },
                        cyclePts.length ? (fmtClock(cyclePts[0][0]) + ' ~ ' + fmtClock(cyclePts[cyclePts.length - 1][0])) : '60 秒/点')
                ]),
                /* 说明：v1.21.4 需求：周期越来越多，横向标签排不下且无法管理。
 * 改为「周期 n/m」按钮 → 点开底部浮层，浮层内可选择与删除历史周期。
 */
                visCycles.length > 1 ? h('button', {
                    key: 'cycbtn',
                    onClick: function () { setCycSheet(true); setHoverPt(null); },
                    className: 'flex items-center gap-1.5 mb-2 px-3 py-1.5 rounded-xl text-[11px] font-bold border ' +
                        'bg-emerald-50 dark:bg-white/5 border-emerald-200/70 dark:border-white/10 ' +
                        'text-emerald-700 dark:text-slate-300 active:opacity-60'
                }, [
                    h(Icon, { key: 'i', name: 'activity', className: 'w-3 h-3' }),
                    h('span', { key: 't' }, '周期 ' + (selIdx + 1) + '/' + visCycles.length),
                    hiddenCount > 0 ? h('span', { key: 'h', className: 'text-slate-400 font-medium' }, '（已删 ' + hiddenCount + '）') : null,
                    h(Icon, { key: 'c', name: 'chevron-down', className: 'w-3 h-3 opacity-60' })
                ]) : null,
                cyclePts.length
                    ? dischargeChart
                    : h('div', { className: 'text-[11px] text-slate-400 py-8 text-center leading-relaxed' },
                        loading ? '加载中…' : '暂无曲线数据：守护运行约 1 分钟后开始记录\n（电量 + 前台应用，每 60 秒一针）'),
                /* 说明：v1.26.0：图例拆成三行（用户要求）——
 * ① 累计掉电单独一行、靠左；
 * ② 颜色线标明单独一行（字号与「分时段功率走势」图例统一为 9px）；
 * ③「点曲线看详情」单独一行、靠右。
 * 原来三样挤在同一个 flex-wrap 里，窄屏下会折成两行且先后顺序不可控。
 */
                cyclePts.length ? h('div', { className: 'mt-1.5' }, [
                    /* 说明：第一行：累计掉电（醒目，靠左） */
                    h('div', { key: 'drop', className: 'text-[11px] font-black text-orange-600 dark:text-orange-400 whitespace-nowrap' },
                        '累计掉电 ' + cycDropPct.toFixed(1) + '%'),
                    /* 说明：第二行：颜色 ↔ 含义 */
                    h('div', { key: 'legend', className: 'flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[9px] font-medium' }, [
                        /* 说明：v1.20.0 需求5-2：图例可点击——亮/息屏段与温度线独立开关 */
                        /* 说明：v1.23.3：图例与画法同步——线色只表示充放，息屏改由底纹表示。
 * 原来「放电/息屏」两个可点项分别控制亮屏段与息屏段，现在只剩息屏底纹可开关。
 */
                        h('span', { key: 'k0', className: 'flex items-center gap-1.5 text-slate-400' }, [
                            h('span', { key: 'c', className: 'inline-block w-4 h-0.5 rounded', style: { background: '#22c55e' } }),
                            '放电']),
                        h('span', { key: 'k3x', className: 'flex items-center gap-1.5' }, [
                            h('span', { key: 'c', className: 'inline-block w-4 h-0.5 rounded', style: { background: '#94a3b8', opacity: 0.55 } }),
                            '充电（弱化）']),
                        /* 说明：v1.25.0：满电插着充电器的那段单独一档——它不是充电，也不该像放电 */
                        h('span', { key: 'k3f', className: 'flex items-center gap-1.5' }, [
                            h('span', { key: 'c', className: 'inline-block w-4 h-0.5 rounded', style: { background: '#cbd5e1', opacity: 0.7 } }),
                            '已满（插电）']),
                        h('span', { key: 'k3', className: 'flex items-center gap-1.5 cursor-pointer select-none ' +
                                (legend.off ? 'text-slate-400' : 'text-slate-300 dark:text-slate-600 line-through'),
                            onClick: function () { setLegend(Object.assign({}, legend, { off: !legend.off })); } }, [
                            h('span', { key: 'c', className: 'inline-block w-3.5 h-2.5 rounded-sm', style: { background: '#a855f7', opacity: legend.off ? 0.25 : 0.13 } }),
                            '息屏（底纹）']),
                        h('span', { key: 'kb', className: 'flex items-center gap-1.5 cursor-pointer select-none ' +
                                (legend.bt ? 'text-slate-400' : 'text-slate-300 dark:text-slate-600 line-through'),
                            onClick: function () { setLegend(Object.assign({}, legend, { bt: !legend.bt })); } }, [
                            h('span', { key: 'c', className: 'inline-block w-4 h-0.5 rounded', style: { background: '#f59e0b', opacity: legend.bt ? 1 : 0.25 } }),
                            '电池温']),
                        h('span', { key: 'kc', className: 'flex items-center gap-1.5 cursor-pointer select-none ' +
                                (legend.ct ? 'text-slate-400' : 'text-slate-300 dark:text-slate-600 line-through'),
                            onClick: function () { setLegend(Object.assign({}, legend, { ct: !legend.ct })); } }, [
                            h('span', { key: 'c', className: 'inline-block w-4 h-0.5 rounded', style: { background: '#ef4444', opacity: legend.ct ? 1 : 0.25 } }),
                            'CPU温']),
                        /* 说明：v1.21.1 需求2：CPU 温度曲线平滑开关（默认开；关闭看原始毛刺） */
                        h('span', { key: 'ks', className: 'flex items-center gap-1.5 cursor-pointer select-none ' +
                                (legend.smooth !== false ? 'text-slate-400' : 'text-slate-300 dark:text-slate-600 line-through'),
                            onClick: function () {
                                setLegend(Object.assign({}, legend, { smooth: legend.smooth === false }));
                            } }, [
                            h('span', { key: 'c', className: 'inline-block px-1 rounded text-[9px] font-bold border',
                                style: {
                                    borderColor: legend.smooth !== false ? '#ef4444' : '#cbd5e1',
                                    color: legend.smooth !== false ? '#ef4444' : '#94a3b8',
                                    opacity: legend.smooth !== false ? 1 : 0.5
                                } }, '平滑')])
                    ]),
                    h(NetworkLegend, { key: 'network' }),
                    /* 说明：第三行：操作提示（靠右） */
                    h('div', { key: 'hint', className: 'text-[9px] text-slate-400/80 text-right mt-0.5' }, '点曲线看详情')
                ]) : null
            ]),

            /* 说明：指标卡行（v1.18.0：核心实时大字 + 功耗条可视化 + 图标层级） */
            /* 说明：行1：核心实时数据（放大字号 + 强调样式，最醒目位置） */
            h('div', { className: 'grid grid-cols-3 gap-2' }, [
                /* 说明：v1.25.0：状态取 chg_state（旧 dump 退回功率正负），
 * "已充满"不再显示成"充电中"——100% 插着充电器时功率接近 0，
 * 正负号本来就不可靠，不能拿来当充放结论。
 */
                (function () {
                    var st = (chgState === null) ? (pwrNowMw > 0 ? 1 : (pwrNowMw < 0 ? 0 : -1)) : chgState;
                    var sub = st === 1 ? CHG_KIND_TEXT.chg
                        : (st === 2 ? '已充满 · 插电'
                        : (st === 3 ? CHG_KIND_TEXT.plug
                        : (st === 0 ? CHG_KIND_TEXT.dis : '等待采样')));
                    var tone = st === 1 ? 'chg' : (st === 0 ? 'dis' : null);
                    var val = pwrNowMw !== 0
                        ? (st === 1 ? '+' : '') + fmtW(Math.abs(pwrNowMw))
                        : '读取中';
                    return coreCard('实时功率', val, sub, 'zap', tone);
                })(),
                /* 说明：v1.20.0 需求3：温度卡补周期最高值 + 状态提示（正常/偏高/过热）
 * v1.21.4：原「偏高 · 本周期最高 41.8°」超出卡片宽度，精简为「偏高 · 峰 41.8°」
 */
                 coreCard('电池温度', battTCur > 0 ? battTCur.toFixed(1) + '°C' : '采样中',
                    (btState || '采样中') + (cycBtMax > 0 ? ' · 峰 ' + cycBtMax.toFixed(1) + '°' : ''),
                    'battery', battTCur >= 42 ? 'dis' : null),
                 coreCard('CPU 温度', cpuTCur > 0 ? cpuTCur.toFixed(0) + '°C' : '采样中',
                    (ctState || '采样中') + (cycCtMax > 0 ? ' · 峰 ' + cycCtMax.toFixed(0) + '°' : ''),
                    'cpu', cpuTCur > 60 ? 'dis' : null)
            ]),
            /* 说明：行2：功耗（v1.34.0：标题改平均功耗；收起态保留整机亮屏一行，整机平均与平均耗电时长常显）
 * 用户需求：三档功耗改平均功耗；息屏/亮屏改整机息屏/整机亮屏；行序整机亮屏→整机息屏→
 * 触摸亮屏→静止亮屏；收起时整机平均和平均耗电时长不收起。全部跟随选中周期（cycleSel）。
 */
            h('div', { 'data-pwr-card': 'true', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                h('div', { className: 'flex items-center justify-between gap-2 mb-2' }, [
                    h('div', { className: 'flex items-center gap-1.5 min-w-0' }, [
                        h('span', { className: 'text-[10px] text-slate-400 font-bold whitespace-nowrap' }, '平均功耗'),
                        h('span', { className: 'text-[9px] text-slate-400 truncate' },
                            (cycleSel < 0 ? '本次放电' : '历史周期') +
                            ' · ' + (cycStats.src === 'C' ? '5s 采样' : '60s 采样'))
                    ]),
                    h('button', {
                        'data-pwr-toggle': 'true',
                        onClick: function () { setPwrOpen(!pwrOpen); },
                        className: 'shrink-0 text-[9px] font-bold text-brand-600 dark:text-brand-400 px-2 py-1 rounded-md ' +
                            'bg-brand-50 dark:bg-brand-500/10 active:opacity-60'
                    }, pwrOpen ? '收起 ▲' : '展开 ›')
                ]),
                (function () {
                    /* 说明：四行口径（v1.34.0 用户指定）：整机亮屏 → 整机息屏 → 触摸亮屏 → 静止亮屏。
 * 收起态只渲染整机亮屏一行；整机平均与平均耗电时长在下方常显。
 */
                    var mx = Math.max(cycStats.touch.avg || 0, cycStats.idle.avg || 0,
                        cycStats.off.avg || 0, cycStats.on.avg || 0, 1);
                    var row = function (key, label, color) {
                        var s = cycStats[key] || {};
                        var v = s.avg || 0;
                        return h('div', { key: key, 'data-pwr-row': key,
                            className: 'flex items-center gap-2' }, [
                            h('span', { className: 'w-16 shrink-0 text-[10px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap' }, label),
                            h('div', { className: 'flex-1 min-w-0 h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden' },
                                h('div', { className: 'h-full rounded-full ' + color,
                                    style: { width: (v > 0 ? Math.max(v / mx * 100, 3) : 0) + '%' } })),
                            h('span', { className: 'w-14 shrink-0 text-right text-[11px] font-black text-slate-700 dark:text-slate-200 whitespace-nowrap tabular-nums' },
                                v > 0 ? fmtW(v) : '—'),
                            /* 说明：该档在本周期内的累计时长（墙钟，充电与停机不计） */
                            h('span', { className: 'w-12 shrink-0 text-right text-[9px] text-slate-400 tabular-nums whitespace-nowrap' },
                                (s.ms > 0) ? fmtDur(s.ms) : '—')
                        ]);
                    };
                    if (!pwrOpen) {
                        return h('div', { className: 'space-y-2', 'data-pwr-collapsed': 'true' },
                            row('on', '整机亮屏', 'bg-teal-400'));
                    }
                    var pw3 = [
                        ['on', '整机亮屏', 'bg-teal-400'],
                        ['off', '整机息屏', 'bg-violet-400'],
                        ['touch', '触摸亮屏', 'bg-brand-500'],
                        ['idle', '静止亮屏', 'bg-sky-400']
                    ];
                    return h('div', { className: 'space-y-2', 'data-pwr-expanded': 'true' },
                        pw3.map(function (p) { return row(p[0], p[1], p[2]); }));
                })(),
                h('div', { className: 'mt-2 pt-2 border-t border-slate-100 dark:border-white/5 space-y-1.5', 'data-pwr-summary': 'true' }, [
                    h('div', {
                        key: 'avg',
                        className: 'w-full flex items-center justify-between gap-2 text-[10px] whitespace-nowrap'
                    }, [
                        h('span', { key: 'l', className: 'flex items-center gap-1.5 min-w-0' }, [
                            h('span', { key: 'k1', className: 'text-slate-500 dark:text-slate-400 font-medium' }, '整机平均'),
                            h('span', { key: 'v1', className: 'font-black text-slate-700 dark:text-slate-200 tabular-nums' },
                                (cycStats.all.avg > 0) ? fmtW(cycStats.all.avg) : '—'),
                            h('span', { key: 'sep', className: 'text-slate-300 dark:text-slate-600' }, '·'),
                            h('span', { key: 'k2', className: 'text-slate-500 dark:text-slate-400 font-medium' }, '平均耗电时长'),
                            h('span', { key: 'v2', className: 'font-black text-slate-700 dark:text-slate-200 tabular-nums' },
                                (cycStats.all.ms > 0) ? fmtDur(cycStats.all.ms) : '—')
                        ]),
                        pwrOpen ? h('button', {
                            key: 'h',
                            onClick: function () { setDrill(drill === 'pwr' ? null : 'pwr'); },
                            className: 'shrink-0 text-brand-600 dark:text-brand-400 font-bold active:opacity-60'
                        }, h('span', { key: 'h', className: 'shrink-0' }, drill === 'pwr' ? '收起 ▲' : '看曲线 ›')) : null
                    ]),
                    pwrOpen ? h('div', { key: 'row2', className: 'flex items-center justify-between gap-2' }, [
                        h('span', { key: 'note', className: 'text-[9px] text-slate-400 leading-snug' },
                            '三档合计 = 平均耗电时长 · 整机亮屏 = 静止+触摸'),
                        h('button', {
                            key: 'btn',
                            onClick: function () { setDrill(drill === 'standby' ? null : 'standby'); },
                            className: 'shrink-0 text-[9px] font-bold text-violet-600 dark:text-violet-400 px-2 py-1 rounded-md ' +
                                'bg-violet-50 dark:bg-violet-500/10 active:opacity-60'
                        }, drill === 'standby' ? '收起 ▲' : ('息屏明细 ' + offSegs.length + ' 段 ›'))
                    ]) : null
                ])
            ]),
            /* 说明：v1.19.0 二级详情面板（评价问题4：能看也能查） */
            drill === 'pwr' ? h('div', { key: 'drp', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                h('div', { className: 'flex items-center justify-between mb-1' }, [
                    h('span', { className: 'text-[11px] font-black text-slate-700 dark:text-slate-200' }, '分时段功率走势'),
                    h('span', { className: 'text-[9px] text-slate-400' }, '按档位分段 · 两条均值线')
                ]),
                pwrSeries.length >= 2
                    ? powerChart
                    : h('div', { className: 'text-[10px] text-slate-400 py-4 text-center' }, '功率样本采集中…'),
                h(NetworkLegend, {}),
                /* 说明：图例：颜色 ↔ 档位一一对应（与三档卡的条色同色系） */
                h('div', { className: 'flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-[9px] text-slate-400' }, [
                    h('span', { key: 'k1', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#6366f1' } }), '触摸']),
                    h('span', { key: 'k2', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#0ea5e9' } }), '静止']),
                    h('span', { key: 'k3', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#a855f7' } }), '整机息屏']),
                    h('span', { key: 'k4', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#94a3b8', opacity: 0.5 } }), '充电']),
                    h('span', { key: 'k5', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#f59e0b' } }), '整机均值']),
                    h('span', { key: 'k6', className: 'flex items-center gap-1' }, [
                        h('span', { key: 'c', className: 'inline-block w-3 h-0.5 rounded', style: { background: '#14b8a6' } }), '整机亮屏均值'])
                ]),
                /* 说明：v1.26.0：两条均值线的数值从图内移出，单独一行放在颜色图例下面（同 9px 字号）。
 * 图里只留虚线本身——320 宽的图里两个数值标签会压住折线，右对齐后还紧贴 y 轴刻度。
 */
                h('div', { key: 'avgline', className: 'mt-0.5 text-[9px] text-slate-400 tabular-nums' },
                    '均值：整机 ' + (cycStats.all.avg > 0 ? fmtW(cycStats.all.avg) : '—') +
                    ' · 整机亮屏 ' + (cycStats.on.avg > 0 ? fmtW(cycStats.on.avg) : '—'))
            ]) : null,
            drill === 'standby' ? h('div', { key: 'drs', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                h('div', { className: 'flex items-center justify-between mb-2' }, [
                    h('span', { className: 'text-[11px] font-black text-slate-700 dark:text-slate-200' }, '息屏时段明细'),
                    h('span', { className: 'text-[9px] text-slate-400' }, offSegs.length + ' 段 · 耗电合计 ' +
                        offSegs.reduce(function (a, s) { return a + s.capDrop; }, 0) + '%')
                ]),
                offSegs.length === 0
                    ? h('div', { className: 'text-[10px] text-slate-400 py-3 text-center' }, '暂无完整息屏段（需亮息屏切换产生分段）')
                    : h('div', { className: 'space-y-1.5 max-h-44 overflow-y-auto pr-1' },
                        offSegs.slice().reverse().slice(0, 20).map(function (s, i) {
                            return h('div', { key: i, className: 'flex items-center gap-2 text-[10px] rounded-lg bg-slate-50 dark:bg-white/5 px-2 py-1.5' }, [
                                h('span', { className: 'w-16 shrink-0 font-bold text-slate-600 dark:text-slate-300 tabular-nums' },
                                    fmtClock(s.t0) + '~' + fmtClock(s.t1)),
                                h('span', { className: 'flex-1 text-slate-400 tabular-nums' },
                                    fmtDur(s.ms != null ? s.ms : (s.t1 - s.t0) * 1000)),
                                h('span', { className: 'shrink-0 font-bold tabular-nums ' +
                                    (s.capDrop > 0 ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400') },
                                    s.capDrop > 0 ? '-' + s.capDrop + '%' : '0%'),
                                h('span', { className: 'w-14 shrink-0 text-right text-slate-500 dark:text-slate-400 tabular-nums' },
                                    s.mw > 0 ? fmtW(s.mw) : '—')
                            ]);
                        }))
            ]) : null,
            /* 说明：v1.33.0 理论续航（默认收起，只展示整机平均）
 * 用户需求：理论续航收起来只展示整机平均，默认收起；展开后看五档区间。
 * 数据源与三档功耗同源（cycStats），计算口径不变。
 */
            h('div', { 'data-eta-card': 'true', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                h('div', { className: 'flex items-center justify-between gap-2 mb-2' }, [
                    h('div', { className: 'flex items-center gap-1.5 min-w-0' }, [
                        h('span', { className: 'p-1 rounded-md shrink-0 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
                            h(Icon, { name: 'compare', className: 'w-3 h-3' })),
                        h('span', { className: 'text-[10px] text-slate-400 font-bold whitespace-nowrap' }, '理论续航'),
                        etaModel.ok ? h('span', { className: 'text-[9px] text-slate-400 whitespace-nowrap' },
                            '剩 ' + Math.round(etaModel.capPct) + '%') : null
                    ]),
                    h('div', { className: 'flex items-center gap-1.5 shrink-0' }, [
                        h('span', { className: 'text-[9px] text-slate-400 whitespace-nowrap' },
                            etaModel.ok ? '最短 ~ 最长' : ''),
                        h('button', {
                            'data-eta-toggle': 'true',
                            onClick: function () { setEtaOpen(!etaOpen); },
                            className: 'text-[9px] font-bold text-emerald-600 dark:text-emerald-400 px-2 py-1 rounded-md ' +
                                'bg-emerald-50 dark:bg-emerald-500/10 active:opacity-60'
                        }, etaOpen ? '收起 ▲' : '展开 ›')
                    ])
                ]),
                etaModel.ok ? h('div', { className: 'space-y-2' }, (function () {
                    /* 说明：条长按五档里的最长值归一：一眼看出「哪档撑得久、区间有多宽」。
 * 条是「区间」，不是单值——左端最短、右端最长，两端之间就是预测范围。
 * 收起态只渲染整机平均一行（用户指定），展开后按原顺序五档全显。
 */
                    var mx = 0;
                    etaModel.rows.forEach(function (r) { if (r.maxH > mx) mx = r.maxH; });
                    if (!(mx > 0)) mx = 1;
                    var rows = etaOpen ? etaModel.rows : etaModel.rows.filter(function (r) { return r.key === 'all'; });
                    return rows.map(function (r) {
                        var has = (r.p > 0 && r.midH > 0);
                        var l = has ? Math.max(0, Math.min(100, r.minH / mx * 100)) : 0;
                        var w = has ? Math.max(2, (r.maxH - r.minH) / mx * 100) : 0;
                        /* 说明：样本不足时只给单值（不编造区间）；四舍五入后两端相同也只显一次 */
                        var txt = '—';
                        if (has) {
                            txt = (r.rng && r.minH.toFixed(1) !== r.maxH.toFixed(1))
                                ? fmtRange(r.minH, r.maxH) : fmtHours(r.midH);
                        }
                        return h('div', { key: r.key, 'data-eta-row': r.key, className: 'flex items-center gap-2' }, [
                            h('span', { className: 'w-16 shrink-0 text-[10px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap' }, r.label),
                            h('div', { className: 'flex-1 min-w-0 h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden relative' },
                                has ? h('div', { className: 'absolute inset-y-0 rounded-full opacity-90 ' + r.color,
                                    style: { left: l + '%', width: w + '%' } }) : null),
                            h('span', { className: 'w-[92px] shrink-0 text-right text-[11px] font-black text-slate-700 dark:text-slate-200 whitespace-nowrap tabular-nums' },
                                txt)
                        ]);
                    });
                })()) : h('div', { className: 'text-[10px] text-slate-400 py-3 text-center leading-relaxed' },
                    '暂无预测：需要有放电采样与电量记录'),
                etaModel.ok && etaOpen ? h('div', { className: 'text-[9px] text-slate-400 mt-2 leading-snug break-words' },
                    '区间 = 该档功率 25%~75% 分位（最省电/最费电的四分之一时段）；能量' +
                    (etaModel.src === 'cal' ? '按本周期实测校准 ' : '按标称容量折算 ') +
                    Math.round(etaModel.mWhPerPct) + ' mWh/%') : null
            ]),
            /* 说明：v1.32.0 充电统计（放电侧之外的第二个方向；v1.35.0 移到理论续航下面并默认精简）
 * 放电侧原先已有平均功耗 / 理论续航 / 应用排行，充电侧只有曲线上一条灰线。
 * 本卡补上充电侧数值：充入电量、充电时长、平均与峰值功率、电池温度、充电能量，
 * 展开后底部一行与放电侧同源对照（充电功率 vs 放电平均功耗、充电能量 vs 放电能量）。
 * 数据源：chgSessions(hist)（与平均功耗同一条 hist、同一个跨度口径）。
 * v1.35.0：默认只展示「充入电量」「充电时长」两行，其余统计与充放对照收起；
 * 卡片右上角展开/收起，展开后按同一顺序显示六行。
 * C 侧 chg_mah / chg_avg_mw / chg_ms 是「自上次重置的累计」，
 * 与"最近一次充电"不是同一口径，故不作主数值，只在口径说明里注明。
 */
            (function () {
                var sess = chgSess.last;
                var mAh = (sess && sess.capGain > 0 && prof && prof.batt_full_ua > 0)
                    ? (prof.batt_full_ua / 1000 * sess.capGain / 100) : 0;
                /* 说明：会话状态文案按「这段 hist 的末点」判，不用 C 侧 chg_state（那是 dump 瞬时值，
 * 与这段历史不同源）：末点仍在充 = 正在充电；插着电但没充入 = 插电中；
 * 已经拔电 = 最近一次（完整充电）。
 */
                var sessState = '';
                if (sess) {
                    var tailKind = ptChgKind(hist[sess.e]);
                    sessState = sess.ongoing ? (tailKind === 'chg' ? '正在充电' : '插电中') : '最近一次';
                }
                var head = h('div', { className: 'flex items-center justify-between gap-2 mb-2' }, [
                    h('div', { className: 'flex items-center gap-1.5 min-w-0' }, [
                        h('span', { className: 'p-1 rounded-md shrink-0 bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400' },
                            h(Icon, { name: 'zap', className: 'w-3 h-3' })),
                        h('span', { className: 'text-[10px] text-slate-400 font-bold whitespace-nowrap' }, '充电统计')
                    ]),
                    h('div', { className: 'flex items-center gap-1.5 shrink-0' }, [
                        h('span', { className: 'text-[9px] text-slate-400 whitespace-nowrap tabular-nums' },
                            sess ? (sessState + ' · ' + fmtClock(sess.t0) + '~' + fmtClock(sess.t1))
                                : '60 秒/点'),
                        sess ? h('button', {
                            key: 'st',
                            'data-chg-stats-toggle': 'true',
                            onClick: function () { setChgStatsOpen(!chgStatsOpen); },
                            className: 'text-[9px] font-bold text-teal-600 dark:text-teal-400 px-2 py-1 rounded-md ' +
                                'bg-teal-50 dark:bg-teal-500/10 active:opacity-60'
                        }, chgStatsOpen ? '收起 ▲' : '展开 ›') : null
                    ])
                ]);
                if (!sess) {
                    return h('div', { key: 'chg', 'data-chg-card': 'true', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                        head,
                        h('div', { className: 'text-[10px] text-slate-400 py-3 text-center leading-relaxed' },
                            loading ? '加载中…'
                                : '暂无充电记录：插上充电器并真正充入电量后自动统计（只插着电不充电不计）')
                    ]);
                }
                /* 说明：六行：v1.35.0 按用户要求把「充入电量」「充电时长」排到最前；
 * 默认收起时只渲染这两行，展开后按同一顺序显示全部。
 */
                var rows = [
                    { k: 'cap', label: '充入电量', value: (sess.capGain > 0 ? '+' + sess.capGain + '%' : '—'),
                        sub: mAh > 0 ? ('≈ ' + Math.round(mAh) + ' mAh · 按标称容量折算')
                            : '无 charge_full 读数，只给百分比' },
                    { k: 'dur', label: '充电时长', value: fmtDur(sess.chgMs), sub: sess.wallMs > sess.chgMs + 60000
                        ? ('插电共 ' + fmtDur(sess.wallMs) + '，其余未充入') : '与插电时长基本一致' },
                    { k: 'pwavg', label: '平均充电功率', value: sess.pwAvg > 0 ? fmtW(sess.pwAvg) : '—', sub: '只计真正充入的时段' },
                    { k: 'pwpeak', label: '峰值充电功率', value: sess.pwPeak > 0 ? fmtW(sess.pwPeak) : '—', sub: '60 秒采样点的最高值' },
                    { k: 'bt', label: '电池温度', value: (sess.btLo > 0 && sess.btHi > 0)
                        ? (sess.btLo.toFixed(1) + '° → ' + sess.btHi.toFixed(1) + '°') : '—', sub: '这段充电的起温与峰值' },
                    { k: 'energy', label: '充电能量', value: fmtWh(sess.eWh), sub: '功率 × 时长积分，非电池化学能量' }
                ];
                /* 说明：放电侧能量：与平均功耗同一条 hist、同一个跨度口径（充电与插电期跳过） */
                var disE = 0, qi;
                for (qi = 0; qi < cyclePts.length; qi++) {
                    var qp = cyclePts[qi];
                    if ((qp.length > 4 ? qp[4] : 0) === 1 || (qp.length > 9 ? qp[9] : -1) === 1) continue;
                    var qmw = (qp.length > 5 ? qp[5] : 0) || 0;
                    /* 说明：与充电能量同一个换算（mW·ms → Wh 除 3.6e9），否则两侧能量不可比 */
                    if (qmw > 0) disE += qmw * histStepMs(cyclePts, qi) / 3.6e9;
                }
                var visible = chgStatsOpen ? rows : rows.slice(0, 2);
                return h('div', { key: 'chg', 'data-chg-card': 'true', className: 'rounded-2xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-3 shadow-sm' }, [
                    head,
                    h('div', {
                        className: 'space-y-1.5',
                        'data-chg-collapsed': chgStatsOpen ? undefined : 'true',
                        'data-chg-expanded': chgStatsOpen ? 'true' : undefined
                    }, visible.map(function (r) {
                        return h('div', { key: r.k, 'data-chg-row': r.k, className: 'flex items-start gap-2' }, [
                            h('span', { className: 'w-16 shrink-0 text-[10px] text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap' }, r.label),
                            h('div', { className: 'flex-1 min-w-0' }, [
                                h('div', { className: 'text-[12px] font-black text-slate-700 dark:text-slate-200 tabular-nums whitespace-nowrap' }, r.value),
                                h('div', { className: 'text-[9px] text-slate-400 leading-snug break-words' }, r.sub)
                            ])
                        ]);
                    })),
                    chgStatsOpen ? h('div', { className: 'mt-2 pt-2 border-t border-slate-100 dark:border-white/5 space-y-1.5', 'data-chg-compare': 'true' }, [
                        h('div', { key: 'cmp', className: 'flex items-center justify-between gap-2 text-[10px] whitespace-nowrap tabular-nums' }, [
                            h('span', { key: 'c', className: 'text-teal-600 dark:text-teal-400 font-bold' },
                                '充 ' + (sess.pwAvg > 0 ? fmtW(sess.pwAvg) : '—') + ' · ' + fmtWh(sess.eWh)),
                            h('span', { key: 'm', className: 'text-[9px] text-slate-300 dark:text-slate-600 shrink-0' }, '对照'),
                            h('span', { key: 'd', className: 'text-orange-600 dark:text-orange-400 font-bold' },
                                '放 ' + (cycStats.all.avg > 0 ? fmtW(cycStats.all.avg) : '—') + ' · ' + fmtWh(disE))
                        ])
                    ]) : null,
                    h('div', { className: 'mt-2 pt-2 border-t border-slate-100 dark:border-white/5' }, [
                        h('button', {
                            key: 'btn',
                            onClick: function () { setChgOpen(!chgOpen); },
                            'data-charge-toggle': 'true',
                            className: 'w-full flex items-center justify-between gap-2 text-[10px] whitespace-nowrap active:opacity-60'
                        }, [
                            h('span', { key: 'l', className: 'text-[9px] text-slate-400' },
                                '曲线：功率 × 时间 · ' + sess.pts.length + ' 点'),
                            h('span', { key: 'h', className: 'shrink-0 text-teal-600 dark:text-teal-400 font-bold' },
                                chgOpen ? '收起 ▲' : '充电功率曲线 ›')
                        ])
                    ])
                ]);
            })(),
            /* 说明：v1.35.0：不充电时充电曲线默认收起；用户点开后在充电统计卡下方展示。
 * 充电时曲线已在页面顶部优先展示（见 root 第一个子节点），这里不重复。
 */
            !chargingNow ? chargeChartNode : null,
            /* 说明：v1.23.3：删除「已使用时长」独立卡
 * 用户反馈：这张卡按「拔电到现在」的墙钟算，含充电与守护停机时段，
 * 与三档时长合计（只算放电采样）天生不一致，同一页两个时间互相矛盾。
 * 现已合并进三档功耗卡的「本次耗电时长」（= 三档时长合计），
 * 全页只保留一个时间口径。
 * v1.26.0：三口径（拔电后/插电后/充满后）连「排行统计范围」一并删除——
 * 充电锚点会把充电/插电时段算进耗电窗口，物理上不成立；
 * 排行窗口现固定为「选中放电周期」，与三档/续航同源。
 */
            /* 说明：v1.18.1 指标口径说明（v1.23.0 补三档与周期；v1.23.2 补回理论续航；
 * v1.23.3 改时间口径 + 五档续航）
 */
            h('details', { className: 'text-[10px] text-slate-400 leading-relaxed -mt-2' }, [
                h('summary', { className: 'cursor-pointer select-none' }, 'ⓘ 各指标口径说明'),
                h('div', { className: 'mt-1 space-y-1' }, [
                    h('div', {}, '平均功耗：把选中周期内的采样按「触摸亮屏 / 静止亮屏 / 整机息屏」分档求功率均值；整机亮屏 = 静止 + 触摸（时长相加、功率按时长加权），整机平均 = 三档按时长加权。功率优先用守护的 5s 采样（当前周期），历史周期按 60s 采样点现算。时长按每针到下一针的真实间隔累计，充电与守护停机时段不计，所以三档时长合计就是「平均耗电时长」，与理论续航同源。'),
                    h('div', {}, '平均耗电时长：选中周期内所有未插电放电时段（整机亮屏 + 整机息屏）的墙钟之和 = 三档时长合计。充满后仍插着充电器、充电中与守护停机时段均不计入（v1.23.3 改口径，v1.27.0 排除插电未充）。'),
                    h('div', {}, '理论续航：剩余电量 × 每 1% 能量 ÷ 该档平均功率。每 1% 能量按选中周期实测校准（周期放电能量 ÷ 周期掉电%），掉电不足 5% 时退回「标称容量 × 3.85V」折算，卡内会写明用的是哪种。区间取该档功率的时间加权 25%~75% 分位——最省电的四分之一时段撑得最久（区间右端），最费电的四分之一撑得最短（左端）。五档依次为整机平均 / 整机亮屏 / 静止亮屏 / 触摸亮屏 / 整机息屏。'),
                    h('div', {}, '息屏明细：选中周期内每一段连续息屏（且未插电放电）的起止时间、时长、掉电百分比与平均功率，随周期切换一起变化。息屏时充电或插着充电器的时段不计入。'),
                    h('div', {}, '电量曲线：绿色=放电、灰色=充电、浅灰=已满/插电未充；浅紫底纹=息屏时段；下方网络色带标出 WLAN、纯流量、无网络，灰浅色为未记录或采样缺口，紫色为其他网络。网络按默认连接识别，约一分钟采样，边界为估计；无网络不等同于公网连通性检测。两个维度分开画，所以「息屏 + 充电/插电」会显示为灰线压在底纹上，长按曲线看浮窗里的状态行确认。'),
                    h('div', {}, '应用耗电排行：统计窗口固定为「选中放电周期」，与平均功耗/理论续航同一个窗口。原「统计范围（拔电后/插电后/充满后）」已删除——那两个充电锚点会把充电与插电时段算进窗口，而充电时功率是充进电池的正数，统计「耗电」不成立（v1.26.0 改）。场景四档（全部/亮屏/触摸/息屏）在窗口内再分桶；右上角时钟图标切换「按时间 / 按功耗」排序，橙=按时间（默认开启），灰=按功耗（按平均功率降序，功耗最高的排最前）（v1.26.1 改默认值，v1.26.2 改按功耗口径）。'),
                    h('div', {}, '充电及插电未充（已充满仍插着充电器）期间均不计入任何功耗、待机与时长统计，避免外部供电与充电发热污染放电画像。'),
                    h('div', {}, '充电统计：从 hist 切出「连续插电且真的向电池充入」的区间作为一次充电（最近一次，与选中放电周期无关——一次充电正好横跨两个放电周期之间）。充入电量按电量增长算百分比，mAh 由标称容量折算；充电功率与能量只取「充电中」的采样点（已充满/插电未充不算充电，功率只维持电量）；能量是功率×时长积分，不是电池化学能量。峰值功率受 60 秒采样粒度限制，真实瞬时峰值可能更高。C 侧 dump 另有「自上次重置的累计」充电电量/平均功率/累计时长，与这里的单次口径不同源，故不在卡片上并列。v1.35.0 起充电统计默认只展示充入电量与充电时长，展开后显示其余统计与充放对照；充电曲线另叠加充电百分比线（右轴 0~100%）。')
                ])
            ]),

            /* 说明：APP 列表（按耗电降序） */
            h('div', { className: 'rounded-3xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 p-5 shadow-sm' }, [
                /* 说明：v1.26.0：排行卡两处改动——
 * ① 删「统计范围（拔电后/插电后/充满后）」：那两个充电锚点把充电时段
 * 也算进窗口，而充电时 mw 是充进电池的正数，统计「耗电」不成立
 * （见 appScrData 的注释）。窗口固定为选中放电周期。
 * ② 右上角加小时钟图标切换「按功耗 / 按时间」排序：场景四档不变。
 * v1.26.1：默认改为时钟开启（按时间，图标橙亮）；关掉时钟即按功耗
 * （v1.26.2：平均功率降序，最高功耗者排最前）。
 */
                h('div', { className: 'mb-3' }, [
                    h('div', { className: 'flex items-center gap-2' }, [
                        h('div', { className: 'p-2 rounded-xl bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 shrink-0' },
                            h(Icon, { name: 'grid', className: 'w-4 h-4' })),
                        h('h3', { className: 'font-bold text-[15px] whitespace-nowrap' }, '应用耗电排行'),
                        h('span', { className: 'text-[10px] text-slate-400 font-medium ml-auto shrink-0 whitespace-nowrap' },
                            appScr === 'all' ? '亮屏+息屏'
                                : (appScr === 'on' ? '仅亮屏'
                                    : (appScr === 'touch' ? '触摸时段' : '仅息屏'))),
                        /* 说明：图标本身即开关：亮（橙）= 按时间（默认），灰 = 按功耗（时钟关闭）。
 * title 同时说明「当前是什么」和「点一下变什么」，不只写动作。
 */
                        h('button', {
                            key: 'sort',
                            type: 'button',
                            onClick: function () { setSortBy(sortBy === 'time' ? 'power' : 'time'); },
                            title: sortBy === 'time' ? '按时间排序 · 点按关闭时钟，改按功耗' : '按功耗排序（功耗最高在前） · 点按开启时钟，改按时间',
                            'aria-label': sortBy === 'time' ? '按时间排序（默认开启）' : '按功耗排序（时钟已关闭）',
                            className: 'shrink-0 p-1 rounded-lg border transition-colors active:opacity-60 ' +
                                (sortBy === 'time'
                                    ? 'bg-orange-500 border-orange-500 text-white shadow-sm'
                                    : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-300 dark:text-slate-600')
                        }, h(Icon, { name: 'clock', className: 'w-3.5 h-3.5' }))
                    ]),
                    /* 说明：场景切换：全部 / 亮屏 / 触摸 / 息屏（v1.22.0 四档） */
                    h('div', { className: 'flex gap-1.5 mt-2' }, [
                        ['all', '全部'],
                        ['on', '亮屏'],
                        ['touch', '触摸'],
                        ['off', '息屏']
                    ].map(function (o) {
                        var on = appScr === o[0];
                        return h('button', {
                            key: o[0],
                            onClick: function () { setAppScr(o[0]); },
                            className: 'px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-colors ' +
                                (on ? 'bg-orange-500 border-orange-500 text-white shadow-sm'
                                    : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400')
                        }, o[1]);
                    })),
                    /* 说明：v1.26.0：统计范围按钮组删除——窗口不再可选，这里只说明窗口是哪个。 */
                    h('div', { className: 'text-[10px] text-slate-400 mt-1.5 leading-snug' },
                        '统计窗口：' + (cycleSel < 0 ? '本次放电' : '选中历史周期') + ' · 仅放电期（充电/插电不计）')
                ]),
                scList.length === 0
                    ? h('div', { className: 'text-[11px] text-slate-400 py-6 text-center' },
                        loading ? '加载中…'
                            : (appScr === 'touch'
                                ? '暂无触摸数据：需 v1.22.0 起的守护采样（旧数据无触摸标记）'
                                : (appScr === 'on' ? '暂无亮屏数据：守护采样后自动生成'
                                    : (appScr === 'off' ? '暂无息屏数据：需有息屏时段的前台记录'
                                        : '暂无数据：守护采样后自动生成'))))
                    : h('div', { className: 'space-y-2' }, scVisible.map(function (a) {
                        var dispName = NameResolver.cache[a.pkg] || NameResolver.formatFallback(a.pkg);
                        var pwTxt = (a.pwn > 0 && a.pw > 0) ? fmtW(a.pw) : '—';
                        /* 说明：v1.14.0：平均温度（tavg，电池温度）+ 最高温度（tmax）双显 */
                        var avgTxt = (a.tavg > 0) ? a.tavg.toFixed(1) + '°' : '—';
                        var tTxt = (a.tmax > 0) ? a.tmax.toFixed(1) + '°' : '—';
                        var tCls = a.tmax >= 45 ? 'text-rose-600 dark:text-rose-400'
                            : (a.tmax >= 40 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400');
                        var aCls = a.tavg >= 40 ? 'text-rose-600 dark:text-rose-400'
                            : (a.tavg >= 37 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400');
                        /* 说明：v1.21.6 需求：图标要相对整个两行条目上下居中。
 * 原来图标只跟第一行（名称）居中对齐，两行布局下看着偏上。
 * 现改为「外层 items-center + 右侧包住两行的容器」，
 * 图标自然与两行块垂直居中；第二行也就不需要 pl-9 手动缩进了。
 */
                        return h('div', {
                            key: a.pkg,
                            className: 'rounded-xl bg-slate-50 dark:bg-white/5 px-2.5 py-2 select-none',
                            style: { WebkitTouchCallout: 'none' },
                            onPointerDown: function (e) {
                                /* 说明：v1.21.4 修复：原来在 cancel 里用 e.currentTarget —— React 合成事件
 * 的 currentTarget 在回调结束后会被置 null，抬手时 cancel 一执行就抛
 * TypeError（就是"点击后出现报错"的根因）。改为先存下真实节点。
 * 同时加 8px 移动阈值：手指轻微抖动不再直接取消长按。
 */
                                var el = e.currentTarget;
                                var x0 = e.clientX, y0 = e.clientY;
                                var t = setTimeout(function () {
                                    setPkgSheet({ name: dispName, pkg: a.pkg });
                                }, 500);
                                var off = function () {
                                    clearTimeout(t);
                                    if (!el) return;
                                    el.removeEventListener('pointerup', off);
                                    el.removeEventListener('pointerleave', off);
                                    el.removeEventListener('pointermove', onMove);
                                };
                                var onMove = function (ev) {
                                    if (Math.abs(ev.clientX - x0) > 8 || Math.abs(ev.clientY - y0) > 8) off();
                                };
                                if (el) {
                                    el.addEventListener('pointerup', off);
                                    el.addEventListener('pointerleave', off);
                                    el.addEventListener('pointermove', onMove);
                                }
                            }
                        }, [
                            h('div', { className: 'flex items-center gap-2.5 min-w-0' }, [
                                /* 说明：v1.26.3：统一走 CP.AppIcon——底色+首字母打底，真图标解码后淡入；
 * 不再"要么 img、要么首字母"，那种二选一在解码前会空一帧（看着就是闪）。
 */
                                h(AppIcon, {
                                    key: 'ic',
                                    pkg: a.pkg,
                                    loadingAnimation: true,
                                    className: 'w-7 h-7 rounded-lg shrink-0 text-white text-[10px] font-black'
                                }),
                                h('div', { className: 'flex-1 min-w-0' }, [
                                    /* 说明：第一行：应用名单行省略（完整名在长按浮层里） */
                                    h('div', { className: 'text-[12px] font-bold text-slate-700 dark:text-slate-200 leading-tight truncate' },
                                        dispName),
                                    /* 说明：第二行：左「功耗 + 均温 + 峰温」，右下角使用时长 */
                                    h('div', { className: 'flex items-center justify-between gap-2 mt-0.5 min-w-0' }, [
                                        h('div', { className: 'flex items-center gap-2 min-w-0 text-[10px] font-bold whitespace-nowrap' }, [
                                            h('span', { key: 'pw', className: 'text-slate-600 dark:text-slate-300 tabular-nums' }, pwTxt),
                                            h('span', { key: 'av', className: aCls + ' tabular-nums' }, '均 ' + avgTxt),
                                            h('span', { key: 'pk', className: tCls + ' tabular-nums' }, '峰 ' + tTxt)
                                        ]),
                                        h('span', { className: 'shrink-0 text-[10px] font-bold text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap' },
                                            fmtDur(a.ms || 0))
                                    ])
                                ])
                            ])
                        ]);
                    })), scList.length > appLimit
                        ? h('button', {
                            key: 'app-more',
                            onClick: function () { setAppLimit(function (n) { return n + 20; }); },
                            className: 'w-full mt-2 py-2 rounded-xl text-[11px] font-bold bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400'
                        }, '显示更多（已 ' + Math.min(appLimit, scList.length) + ' / ' + scList.length + '）')
                        : null
            ]),
            /* 说明：v1.21.4 需求：周期管理浮层——选择历史周期 + 删除（本地隐藏）。
 * 入口是图表卡上的「周期 n/m」按钮。删除以周期起点时间戳为身份落盘到
 * cycle_hidden.txt；浮层底部提供「恢复已删除」撤回。
 * v1.21.6 三项修复（用户反馈）：
 * ① 底部被系统状态栏/手势条挡住 → 容器加 safe-area-inset-bottom 内边距；
 * ② 打开时背景页面还能跟着划 → 由组件内的 useEffect 锁 body 滚动；
 * ③ 外圈灰罩子不好看 → 去掉 bg-black/40，改成面板自身的大阴影 + 细描边，
 * 靠层次而不是压暗来分离前后景。
 */
            cycSheet ? h('div', {
                key: 'cycsheet',
                className: 'fixed inset-0 z-50 flex items-end justify-center px-4 pt-4 bg-transparent',
                style: { paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' },
                onClick: function () { setCycSheet(false); }
            }, [
                h('div', {
                    className: 'w-full max-w-md rounded-2xl bg-white dark:bg-[#1c1c1e] ' +
                        'shadow-[0_-6px_16px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.30)] ' +
                        'ring-1 ring-black/5 dark:ring-white/10 max-h-[70vh] flex flex-col',
                    onClick: function (e) { e.stopPropagation(); }
                }, [
                    h('div', { className: 'px-4 pt-4 pb-2 shrink-0' }, [
                        h('div', { className: 'text-[14px] font-black text-slate-800 dark:text-white' }, '放电周期'),
                        h('div', { className: 'text-[10px] text-slate-400 mt-0.5 leading-snug' },
                            '点周期切换查看；点右侧删除仅在本页隐藏该周期（可恢复）')
                    ]),
                    h('div', { className: 'px-3 pb-1 overflow-y-auto no-scrollbar flex-1' },
                        visCycles.slice().reverse().map(function (c) {
                            var gi = visCycles.indexOf(c);
                            var isCur = gi === visCycles.length - 1;
                            var on = gi === selIdx;
                            var pts = hist.slice(c.s, c.e);
                            var drop = pts.length >= 2
                                ? Math.max(pts[0][1] - pts[pts.length - 1][1], 0) : 0;
                            var spanMs = pts.length >= 2
                                ? (pts[pts.length - 1][0] - pts[0][0]) * 1000 : 0;
                            return h('div', {
                                key: 'cy' + c.s,
                                className: 'flex items-center gap-2 px-2 py-2 mb-1 rounded-xl ' +
                                    (on ? 'bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-300/70 dark:border-emerald-500/30'
                                        : 'border border-transparent')
                            }, [
                                h('button', {
                                    onClick: function () {
                                        setCycleSel(isCur ? -1 : gi);
                                        setHoverPt(null);
                                        setCycSheet(false);
                                    },
                                    className: 'flex-1 min-w-0 text-left active:opacity-60'
                                }, [
                                    h('div', { className: 'flex items-center gap-1.5' }, [
                                        h('span', { className: 'text-[12px] font-bold text-slate-700 dark:text-slate-200 truncate' },
                                            fmtDayClock(hist[c.s][0])),
                                        isCur ? h('span', {
                                            key: 'cur',
                                            className: 'shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-black bg-emerald-500 text-white'
                                        }, '当前') : null
                                    ]),
                                    h('div', { className: 'text-[10px] text-slate-400 mt-0.5 truncate' },
                                        '时长 ' + fmtDur(spanMs) + ' · 掉电 ' + drop.toFixed(1) + '%')
                                ]),
                                isCur ? null : h('button', {
                                    onClick: function () {
                                        saveHidden(hiddenCycles.concat([hist[c.s][0]]));
                                        setCycleSel(-1);
                                    },
                                    className: 'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 ' +
                                        'bg-slate-100 dark:bg-white/10 active:opacity-60',
                                    title: '删除该周期'
                                }, h(Icon, { name: 'trash-2', className: 'w-4 h-4' }))
                            ]);
                        })),
                    h('div', { className: 'p-3 shrink-0 border-t border-slate-100 dark:border-white/5 flex gap-2' }, [
                        hiddenCount > 0 ? h('button', {
                            key: 'rst',
                            onClick: function () { saveHidden([]); },
                            className: 'flex-1 py-2 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-[12px] font-bold text-amber-700 dark:text-amber-400 active:opacity-60'
                        }, '恢复已删除 (' + hiddenCount + ')') : null,
                        h('button', {
                            key: 'close',
                            onClick: function () { setCycSheet(false); },
                            className: 'flex-1 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-[12px] font-bold text-slate-600 dark:text-slate-300 active:opacity-60'
                        }, '关闭')
                    ])
                ])
            ]) : null,
            /* 说明：v1.21.2 需求1-1：长按应用条目弹出的详情浮层（完整名称 + 完整包名）。
 * 点任意处关闭；内容可选中复制（包名常需复制到别处用）。
 * v1.21.6：同样去掉灰罩改阴影，并补底部安全区。
 */
            pkgSheet ? h('div', {
                key: 'pkgsheet',
                className: 'fixed inset-0 z-50 flex items-end justify-center px-4 pt-4 bg-transparent',
                style: { paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' },
                onClick: function () { setPkgSheet(null); }
            }, [
                h('div', {
                    className: 'w-full max-w-md rounded-2xl bg-white dark:bg-[#1c1c1e] p-4 ' +
                        'shadow-[0_-6px_16px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.30)] ' +
                        'ring-1 ring-black/5 dark:ring-white/10',
                    onClick: function (e) { e.stopPropagation(); }
                }, [
                    h('div', { className: 'flex items-center gap-2.5' }, [
                        /* 说明：v1.26.3：浮层图标同样走 AppIcon——打开浮层时不再新建一个未解码的 <img>，
 * 底色+首字母先顶上，已解码过的图标直接首帧上屏。
 */
                        h(AppIcon, {
                            key: 'ic',
                            pkg: pkgSheet.pkg,
                            loadingAnimation: true,
                            className: 'w-9 h-9 rounded-xl shrink-0 text-white text-[11px] font-black'
                        }),
                        h('div', { className: 'flex-1 min-w-0' }, [
                            h('div', { className: 'text-[14px] font-black text-slate-800 dark:text-white leading-snug break-words select-text' },
                                pkgSheet.name),
                            h('div', { className: 'text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5 leading-snug break-all select-text' },
                                pkgSheet.pkg)
                        ])
                    ]),
                    h('button', {
                        onClick: function () { setPkgSheet(null); },
                        className: 'w-full mt-3 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-[12px] font-bold text-slate-600 dark:text-slate-300 active:opacity-60'
                    }, '关闭')
                ])
            ]) : null
        ]);
    };
})(window.CP = window.CP || {});