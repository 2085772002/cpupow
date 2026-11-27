(function (CP) {
  'use strict';
  const h = CP.h;
  const KsuService = CP.KsuService;
  const Icon = CP.Icon;

  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useMemo = React.useMemo;
  var MODULE_DIR = CP.MODULE_DIR;

  /* 说明：v1.15.0 终端日志重写（第 5 条）：
 * - 返回按钮（Tab 精简后从配置页进入，需要回退路径）
 * - 关键词搜索 + 事件类型筛选（前台/触摸/写入/错误），大段原始日志可快速定位
 * - 解析 [HH:MM:SS] 时间戳独立成列，事件类型彩色标签，行高与分隔优化排版
 * - 自动滚动可暂停（翻看历史时不被新日志顶走）
 */

  /* 说明：解析一行日志。优先按结构化格式解析：
   *   [HH:MM:SS.mmm][级别][模块] 事件 key=value ...
   * 旧自由文本格式作为回退，保证升级后历史日志仍可读。 */
  var LEVEL_META = {
    F: { kind: 'error',   label: '致命' },
    E: { kind: 'error',   label: '错误' },
    W: { kind: 'warn',    label: '警告' },
    I: { kind: 'other',   label: '常规' },
    D: { kind: 'raw',     label: '调试' },
    T: { kind: 'raw',     label: '追踪' }
  };
  var MOD_META = {
    boot: 'boot', cfg: 'cfg', tch: 'tch', prb: 'prb', zone: 'zone',
    wrt: 'wrt', bat: 'bat', perf: 'perf', diag: 'diag', core: 'core'
  };
  function parseLine(l) {
    var m = /^\[(\d{2}:\d{2}:\d{2})(?:\.\d{3})?\]\[([FIEWDT])\]\[([a-z]{2,4})\s*\]\s*(.*)$/.exec(l);
    if (m) {
      var lv = LEVEL_META[m[2]] || LEVEL_META.I;
      var mod = MOD_META[m[3]] || m[3];
      return { time: m[1], level: m[2], levelLabel: lv.label, mod: mod, body: m[4], kind: lv.kind };
    }
    /* 旧格式回退 */
    var o = /^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/.exec(l);
    var time = o ? o[1] : '';
    var body = o ? o[2] : l;
    var kind = 'other';
    if (/ERROR|失败|错误/.test(body)) kind = 'error';
    else if (/前台切换/.test(body)) kind = 'focus';
    else if (/触摸开始/.test(body)) kind = 'touch_on';
    else if (/触摸结束/.test(body)) kind = 'touch_off';
    else if (/成功写入|写入/.test(body)) kind = 'write';
    else if (/焦点行原文/.test(body)) kind = 'raw';
    return { time: time, level: '', levelLabel: '', mod: '', body: body, kind: kind };
  }

  var KIND_META = {
    error:    { label: '错误', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300' },
    focus:    { label: '前台', cls: 'bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-300' },
    touch_on: { label: '按下', cls: 'bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300' },
    touch_off:{ label: '抬起', cls: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400' },
    write:    { label: '写入', cls: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300' },
    warn:     { label: '警告', cls: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300' },
    raw:      { label: '原始', cls: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500' },
    other:    { label: '事件', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }
  };

  var FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'error', label: '错误' },
    { id: 'focus', label: '前台' },
    { id: 'touch', label: '触摸' },
    { id: 'write', label: '写入' }
  ];

const LogViewer = () => {
                const scope = CP.usePageScope();
                const [logs, setLogs] = useState([]);
                const [query, setQuery] = useState('');
                const [kind, setKind] = useState('all');
                const [paused, setPaused] = useState(false);
                const ref = useRef();
                const [level, setLevel] = useState(null);
                const [saving, setSaving] = useState(false);
                const [configError, setConfigError] = useState('');
                const [readError, setReadError] = useState('');
                const [actionError, setActionError] = useState('');
                const [loaded, setLoaded] = useState(false);
                const [exists, setExists] = useState(false);
                const [configLoaded, setConfigLoaded] = useState(false);
                CP.usePageLoading(!loaded || !configLoaded);
                const alive = useRef(true), pending = useRef(false), revision = useRef(0);
                const actionBusy = useRef(false), poll = useRef(null);
                const lastLogAt = useRef(0);
                const readConfig = async () => {
                    const result = await KsuService.exec('cat ' + MODULE_DIR + '/cpu_policy.json');
                    if (!result || result.errno !== 0) throw Error('日志级别读取失败');
                    const cfg = JSON.parse(result.stdout);
                    if (!cfg || !cfg.global || !Number.isInteger(cfg.global.log_level) || cfg.global.log_level < 0 || cfg.global.log_level > 2) throw Error('日志级别配置无效');
                    return cfg;
                };
                CP.usePageTask(() => {
                    alive.current = true;
                    let cancelled = false;
                    readConfig().then(cfg => {
                        if (!cancelled && alive.current) { setLevel(cfg.global.log_level); setConfigError(''); setConfigLoaded(true); }
                    }).catch(e => { if (!cancelled && alive.current) { setConfigError(e.message || '日志级别读取失败'); setConfigLoaded(true); } });
                    return () => { cancelled = true; revision.current++; };
                }, []);
                useEffect(() => () => { alive.current = false; }, []);
                const changeLevel = async value => {
                    if (actionBusy.current) return;
                    actionBusy.current = true; setSaving(true); setActionError('');
                    try {
                        const cfg = await readConfig(); cfg.global.log_level = value;
                        const result = await KsuService.writeJson(CP.CONFIG_PATH, cfg);
                        if (!result.ok) throw Error('日志级别未保存');
                        if (alive.current) { setLevel(value); setConfigError(''); KsuService.toast('日志级别已保存'); }
                    } catch (e) {
                        if (alive.current) setActionError(e.message || '日志级别未保存');
                    } finally { actionBusy.current = false; if (alive.current) setSaving(false); }
                };
                const fetchLogs = async () => {
                    if (!alive.current || !scope.isActive() || pending.current || actionBusy.current || document.hidden) return;
                    pending.current = true;
                    const generation = revision.current;
                    try {
                        const result = await KsuService.readLogs();
                        if (alive.current && scope.isActive() && generation === revision.current) {
                            setLogs(previous => previous.length === result.lines.length && previous.every((line, index) => line === result.lines[index]) ? previous : result.lines); setExists(result.exists); setReadError(''); setLoaded(true);
                        }
                    } catch (e) {
                        if (alive.current && scope.isActive() && generation === revision.current) { setReadError(e.message || '日志读取失败'); setLoaded(true); }
                    } finally { pending.current = false; }
                };
                /* 说明：切回时若日志还新鲜（3 秒内）就不立刻重读——ksu.exec 是同步桥接，
                 * 每次 tail 都会占住主线程，快速切页时会被放大成明显卡顿。 */
                CP.usePageTask(() => {
                    let live = true, timer;
                    const POLL_MS = 5000;    /* 说明：tail 也是同步桥接，间隔放宽到 5 秒 */
                    const FRESH_MS = 10000;  /* 说明：切回时日志 10 秒内有效就不再起新的 sh */
                    const run = async () => {
                        if (!live || document.hidden) return;
                        await fetchLogs();
                        lastLogAt.current = Date.now();
                    };
                    const arm = ms => { clearTimeout(timer); timer = setTimeout(function () { CP.afterPaint(function () { if (live) run(); }); }, ms); };
                    const next = () => { CP.afterPaint(function () { if (live) run().then(function () { if (live) arm(POLL_MS); }); }); };
                    const visibility = () => { clearTimeout(timer); if (!document.hidden) next(); };
                    poll.current = next;
                    document.addEventListener('visibilitychange', visibility);
                    const age = Date.now() - lastLogAt.current;
                    if (lastLogAt.current && age < FRESH_MS) arm(Math.max(1000, POLL_MS - age));
                    else next();
                    return () => { live = false; clearTimeout(timer); poll.current = null; document.removeEventListener('visibilitychange', visibility); };
                }, []);

                /* 说明：解析 + 筛选 + 搜索，一次 useMemo 避免每帧重算 */
                const view = useMemo(() => {
                    var rows = logs.map(parseLine);
                    if (kind !== 'all') {
                        rows = rows.filter(function (r) {
                            if (kind === 'touch') return r.kind === 'touch_on' || r.kind === 'touch_off';
                            return r.kind === kind;
                        });
                    }
                    if (query) {
                        var q = query.toLowerCase();
                        rows = rows.filter(function (r) { return r.body.toLowerCase().indexOf(q) >= 0 || r.time.indexOf(q) >= 0; });
                    }
                    return rows;
                }, [logs, kind, query]);

                /* 说明：自动滚动到底；暂停时不动 */
                useEffect(() => {
                    if (!paused && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
                }, [view, paused]);

                const clearLog = async () => {
                    if (actionBusy.current) return;
                    actionBusy.current = true; revision.current++; setSaving(true); setActionError('');
                    try {
                        const result = await KsuService.exec('> ' + MODULE_DIR + '/cpu_policy.log');
                        if (!result || result.errno !== 0) throw Error('日志未清空');
                        if (alive.current) { setLogs([]); setExists(true); setReadError(''); setLoaded(true); KsuService.toast('日志已清空'); }
                    } catch (e) { if (alive.current) setActionError(e.message || '日志未清空'); }
                    finally { actionBusy.current = false; if (alive.current) setSaving(false); }
                };
                const error = configError || actionError || readError;
                const empty = !loaded ? '正在读取日志…' : readError ? '日志暂不可用，请重试' :
                    logs.length ? '没有匹配的日志' : level === 0 ? '当前仅记录致命错误，暂无日志属于正常状态' :
                    !exists ? '尚未生成日志，等待程序记录事件' : '暂无日志';

                return h('div', { className: 'flex flex-col h-[calc(100vh-160px)]' }, [
                    /* 说明：标题行：返回 + 标题 + 清空 */
                    h('div', { className: 'flex items-center gap-2 mb-3 px-1' }, [
                        h('button', {
                            onClick: function () { if (CP.goTab) CP.goTab('status'); },
                            className: 'p-2 -ml-2 rounded-xl bg-white dark:bg-[#121212] border border-slate-200/60 dark:border-white/5 text-slate-500 dark:text-slate-400 active:scale-95 transition-transform',
                            'aria-label': '返回'
                        }, h(Icon, { name: 'chevron-down', className: 'w-4 h-4 rotate-90' })),
                        h('div', { className: 'flex-1 min-w-0' }, [
                            h('h2', { className: 'text-lg font-black tracking-tight leading-tight' }, '终端日志'),
                            h('div', { className: 'text-[10px] text-slate-400' }, '近 300 行 · 每 2 秒刷新')
                        ]),
                        h('button', {
                            onClick: function () {
                                var text = CP.diagText ? CP.diagText() : '(诊断模块未加载)';
                                var file = MODULE_DIR + '/webui-diag.txt';
                                // 说明：用 printf 写文件，避免 heredoc 与引号问题。
                                var quoted = "'" + String(text).replace(/'/g, "'\\''") + "'";
                                KsuService.exec('printf %s ' + quoted + ' > ' + file).then(function (r) {
                                    if (r && r.errno === 0) KsuService.toast('前端诊断已导出: ' + file);
                                    else KsuService.toast('导出失败');
                                });
                            },
                            disabled: saving,
                            className: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-300 px-3.5 py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform'
                        }, '导出前端诊断'),
                        h('button', { onClick: clearLog, disabled: saving, className: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-3.5 py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform' }, '清空')
                    ]),

                    h('div', {'data-log-level':true, className:'flex flex-wrap gap-2 mb-3'},
                        ['0 · 仅致命','1 · 简约','2 · 详细'].map((label,i) => h('button',{
                            key:i,disabled:saving,onClick:()=>changeLevel(i),
                            'aria-pressed':level===i,className:'rounded-xl border px-3 py-2 text-xs '+(level===i?'bg-brand-500 text-white':'')
                        },label))),
                    error ? h('div',{role:'alert',className:'text-xs text-red-500 mb-2'},[error, readError ? h('button', { className: 'ml-3 underline', onClick: () => { if (poll.current) poll.current(); } }, '重试读取') : null]):null,
                    /* 说明：搜索框 */
                    h('div', { className: 'relative mb-2.5' }, [
                        h(Icon, { name: 'search', className: 'absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400' }),
                        h('input', {
                            type: 'text', value: query,
                            onChange: function (e) { setQuery(e.target.value); },
                            placeholder: '搜索日志内容、包名或时间...',
                            className: 'w-full bg-white dark:bg-[#1a1a1a] border border-slate-200 dark:border-white/5 rounded-xl pl-9 pr-9 py-2.5 text-xs focus:ring-2 focus:ring-brand-500/50 outline-none'
                        }),
                        query ? h('button', {
                            onClick: function () { setQuery(''); },
                            className: 'absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 p-1'
                        }, '✕') : null
                    ]),

                    /* 说明：类型筛选 chips + 自动滚动开关 */
                    h('div', { 'data-log-filters': true, className: 'flex items-center gap-1.5 mb-2.5 overflow-x-auto no-scrollbar' }, FILTERS.map(function (f) {
                        var on = kind === f.id;
                        return h('button', {
                            key: f.id,
                            onClick: function () { setKind(f.id); },
                            className: 'shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors border ' +
                                (on ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                                    : 'bg-white dark:bg-[#1a1a1a] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/5')
                        }, f.label);
                    }),
                        h('div', { className: 'flex-1' }),
                        h('button', {
                            onClick: function () { setPaused(function (p) { return !p; }); },
                            title: paused ? '恢复自动滚动' : '暂停自动滚动',
                            className: 'shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold transition-colors border ' +
                                (paused ? 'bg-amber-100 text-amber-600 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
                                    : 'bg-white dark:bg-[#1a1a1a] text-slate-400 border-slate-200 dark:border-white/5')
                        }, paused ? '⏸ 已暂停' : '⏬ 自动')
                    ),

                    /* 说明：命中计数 */
                    (query || kind !== 'all') ? h('div', { className: 'text-[10px] text-slate-400 mb-2 px-1' },
                        '命中 ' + view.length + ' 行' + (query ? '（关键词「' + query + '」）' : '') + (kind !== 'all' ? '（' + (FILTERS.find(function (f) { return f.id === kind; }) || {}).label + '）' : '')) : null,

                    /* 说明：日志主体 */
                    h('div', { className: 'flex-1 bg-[#faf9f6] dark:bg-[#0a0a0a] rounded-2xl border border-slate-200 dark:border-slate-800/80 overflow-hidden shadow-inner min-h-0' },
                        h('div', { ref: ref, className: 'h-full px-3 py-2.5 overflow-y-auto no-scrollbar' }, [
                            view.length === 0
                                ? h('div', { className: 'text-slate-400 text-center mt-10 text-xs' }, empty)
                                : null,
                            view.map(function (r, i) {
                                var meta = KIND_META[r.kind] || KIND_META.other;
                                var isErr = r.kind === 'error';
                                return h('div', {
                                    key: i,
                                    className: 'cp-log-row flex items-start gap-2 py-1.5 border-b border-slate-200/50 dark:border-white/5 last:border-0'
                                }, [
                                    /* 说明：时间戳独立列：扫视时对齐，快速定位时段 */
                                    h('span', { className: 'shrink-0 font-mono text-[10px] text-slate-400 dark:text-slate-500 leading-5 w-[52px] tabular-nums' }, r.time || '--:--:--'),
                                    /* 说明：事件类型标签 */
                                    h('span', { className: 'shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded leading-4 ' + meta.cls }, r.levelLabel || meta.label),
                                    /* 说明：模块列。后端结构化日志自带模块标签，按模块扫读比按正文找关键词快得多。 */
                                    r.mod ? h('span', { className: 'shrink-0 font-mono text-[9px] text-slate-400 dark:text-slate-500 leading-5 w-[26px]' }, r.mod) : null,
                                    /* 说明：正文：错误行加粗红，原始焦点行弱化 */
                                    h('span', {
                                        className: 'flex-1 min-w-0 font-mono text-[11px] leading-5 break-all ' +
                                            (isErr ? 'text-red-500 font-bold'
                                                : r.kind === 'raw' ? 'text-slate-400 dark:text-slate-600'
                                                    : 'text-slate-700 dark:text-slate-300')
                                    }, r.body)
                                ]);
                            })
                        ])
                    )
                ]);
            };

  CP.LogViewer = LogViewer;
})(window.CP = window.CP || {});