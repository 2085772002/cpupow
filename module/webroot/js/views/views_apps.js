(function (CP) {
  'use strict';
  const h = CP.h;
  const KsuService = CP.KsuService;
  const Icon = CP.Icon;
  const AppIcon = CP.AppIcon;
  const NameResolver = CP.NameResolver;
  const MODES = CP.MODES;
  const MODE_LABELS = CP.MODE_LABELS;
  const MODE_CLASS = CP.MODE_CLASS;

  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useMemo = React.useMemo;

/* 说明：应用领域规则：纯计算，既有规则对象及附加字段在修改时保留。 */
const normalizeRules = raw => {
    const obj = Array.isArray(raw) ? { default: 'powersave', rules: raw } : raw;
    if (!obj || typeof obj !== 'object' || (obj.rules !== undefined && !Array.isArray(obj.rules))) throw new Error('invalid rules');
    return { ...obj, default: MODES.includes(obj.default) ? obj.default : 'powersave', rules: obj.rules || [] };
};
const appMode = (rules, pkg) => {
    const rule = rules.rules.find(r => r && r.pkg === pkg);
    return rule && MODES.includes(rule.mode) ? rule.mode : 'default';
};
const selectMode = (rules, pkg, mode) => {
    const exists = rules.rules.some(r => r && r.pkg === pkg);
    const next = { ...rules, rules: mode === 'default'
        ? rules.rules.filter(r => !r || r.pkg !== pkg)
        : rules.rules.map(r => r && r.pkg === pkg ? { ...r, mode } : r) };
    if (!exists && mode !== 'default') next.rules.push({ pkg, mode });
    return next;
};
const compareApps = (rules, times, names, a, b) => {
    const name = pkg => names[pkg] || NameResolver.formatFallback(pkg);
    return Number(appMode(rules, b) !== 'default') - Number(appMode(rules, a) !== 'default') ||
        (times[b] || 0) - (times[a] || 0) ||
        name(a).localeCompare(name(b), 'zh-CN') || a.localeCompare(b);
};
const AppManager = () => {
                const scope = CP.usePageScope();
                const loadedRef = useRef(false), reloadRef = useRef(-1);
                const [appList, setAppList] = useState([]);
                const [usageTimes, setUsageTimes] = useState({});
                const [rules, setRules] = useState({ default: 'balance', rules: [] });
                const [nameMap, setNameMap] = useState(function () { return { ...NameResolver.cache }; });
                /* 说明：v1.26.3：图标存在性白名单移到 IconExtractor（公共内核层，localStorage 持久化），
 * 视图只留一个 tick 用来在探针回来后触发重渲染。
 */
                const [iconTick, setIconTick] = useState(0);
                const [showDefault, setShowDefault] = useState(false);
                const [search, setSearch] = useState('');
                const [loading, setLoading] = useState(true);
                const [selectedPkg, setSelectedPkg] = useState(null);
                const [saving, setSaving] = useState(false);
                const [fetchingNames, setFetchingNames] = useState(false);
                const [appTypes, setAppTypes] = useState({});
                const [category, setCategory] = useState('all');
                const [visibleLimit, setVisibleLimit] = useState(30);
                const [loadError, setLoadError] = useState(false);
                const [saveError, setSaveError] = useState(false);
                const [reload, setReload] = useState(0);
                /* 说明：列表数据提交可被导航打断，标签渐进批次仍沿用可取消队列。 */
                const [renderPending, startRender] = React.useTransition();
                /* 说明：分页追加也走低优先级，避免与切页、滚动抢同一帧。 */
                const [, startTransition] = React.useTransition();
                CP.usePageLoading(loading || renderPending);
                useEffect(() => { setVisibleLimit(30); }, [search, category, reload]);
                const busy = useRef(false), mounted = useRef(true);
                useEffect(() => () => { mounted.current = false; }, []);

                CP.usePageTask(() => {
                    if (loadedRef.current && reloadRef.current === reload) return;
                    let cancelled = false;
                    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                    mounted.current = true;
                    setLoading(true); setLoadError(false);
                    (async () => {
                        try {
                            /* 说明：预热阶段跳过耗电数据读取——它要解析整份电池历史 JSON，
                             * 只用于「按使用时长排序」这个次要条件。用户真正进入本页时再补。 */
                            const needUsage = !scope.warming;
                            const [apps, raw, times] = await Promise.all([
                                KsuService.listApplications(), KsuService.readAppRules(),
                                needUsage
                                    ? KsuService.readProfile('battery', { signal: controller && controller.signal, cache: true }).then(CP.BatteryUsage.currentAppTimes).catch(() => ({}))
                                    : Promise.resolve({})
                            ]);
                            const nextRules = normalizeRules(raw);
                            const pkgs = apps.map(a => a.pkg).sort((a, b) => compareApps(nextRules, times, NameResolver.cache, a, b));
                            /* 说明：首屏仅预热可见批次；不等待离屏图标。 */
                            if (CP.IconExtractor && typeof CP.IconExtractor.prime === 'function') {
                                await Promise.race([
                                    CP.IconExtractor.prime(pkgs.slice(0, 30), true),
                                    new Promise(r => setTimeout(r, 600))
                                ]);
                            }
                            if (cancelled) return;
                            loadedRef.current = true; reloadRef.current = reload;
                            startRender(() => {
                                if (cancelled) return;
                                setAppTypes(Object.fromEntries(apps.map(a => [a.pkg, a.type])));
                                setRules(nextRules); setUsageTimes(times); setAppList(pkgs);
                            });
                        } catch (e) {
                            if (!cancelled) setLoadError(true);
                        } finally {
                            if (!cancelled) setLoading(false);
                        }
                    })();
                    return () => { cancelled = true; if (controller) controller.abort(); };
                }, [reload]);

                CP.usePageTask(() => {
                    if (appList.length === 0) { setFetchingNames(false); return; }
                    let cancelled = false, timer = null;
                    const controller = new AbortController();
                    const pendingNames = appList.filter(pkg => !NameResolver.cache[pkg]);
                    if (!pendingNames.length) { setFetchingNames(false); return; }
                    setFetchingNames(true);
                    setNameMap(previous => Object.keys(NameResolver.cache).every(pkg => previous[pkg] === NameResolver.cache[pkg]) ? previous : ({ ...previous, ...NameResolver.cache }));
                    const CHUNK_SIZE = 8;
                    const runBatch = async (index) => {
                        if (cancelled) return;
                        if (index >= pendingNames.length) { setFetchingNames(false); return; }
                        const chunk = pendingNames.slice(index, index + CHUNK_SIZE);
                        const promises = chunk.map(async (pkg) => {
                            try { return { pkg, name: await NameResolver.resolve(pkg, { signal: controller.signal }) }; } 
                            catch { return { pkg, name: NameResolver.formatFallback(pkg) }; }
                        });
                        const results = await Promise.all(promises);
                        if (cancelled) return;
                        const batchMap = {};
                        results.forEach(r => batchMap[r.pkg] = r.name);
                        setNameMap(prev => ({ ...prev, ...batchMap }));
                        timer = setTimeout(() => runBatch(index + CHUNK_SIZE), 80);
                    };
                    runBatch(0);
                    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
                }, [appList]);

                /* 说明：真图标（v1.26.3）：白名单由 IconExtractor 持有并持久化到 localStorage——
 * 重进页面首帧就知道哪些包有图标，不再「先色块、后图标」地闪一下。
 * 探针仍走 ls（存在的包才渲染 img，全程零 404 请求）；
 * 缺失包一次性提交后台链提取（launch 不等待不堆积），4s 复探渐进上屏。
 */
                const getAppMode = pkg => appMode(rules, pkg);
                const commit = async next => {
                    if (busy.current || loading || loadError) return;
                    busy.current = true; setSaving(true); setSaveError(false);
                    try {
                        const result = await KsuService.writeAppRules(next);
                        if (!result.ok) throw new Error('write failed');
                        if (mounted.current) {
                            setRules(next); setSelectedPkg(null); setShowDefault(false);
                            KsuService.toast('应用模式已保存，守护进程将按前台应用切换');
                        }
                    } catch (e) {
                        if (mounted.current) { setSaveError(true); KsuService.toast('未能应用配置，请重试'); }
                    } finally {
                        busy.current = false;
                        if (mounted.current) setSaving(false);
                    }
                };
                const setMode = (pkg, mode) => {
                    if (getAppMode(pkg) === mode) { setSelectedPkg(null); return; }
                    commit(selectMode(rules, pkg, mode));
                };
                const openApp = pkg => { if (!busy.current) { setSaveError(false); setSelectedPkg(pkg); } };
                const closePanel = () => { if (!busy.current) { setSelectedPkg(null); setShowDefault(false); setSaveError(false); } };
                /* 说明：规则索引和排序键按输入缓存，避免比较函数每次线性扫描规则及重复中文整理。 */
                const modeIndex = useMemo(() => Object.fromEntries(rules.rules.filter(r => r && r.pkg).map(r => [r.pkg, MODES.includes(r.mode) ? r.mode : 'default'])), [rules]);
                const collator = useMemo(() => new Intl.Collator('zh-CN'), []);
                /* 说明：名称表用 ref 镜像。应用名是分批到达的（每批几个），若让排序直接依赖它，
                 * 每次到达都会重排整张列表并跑大量中文 Collator 比较，这是本页最明显的卡顿源。
                 * 排序只依赖稳定输入，名称更新只触发渲染不触发重排。 */
                const nameRef = useRef(nameMap);
                useEffect(() => { nameRef.current = nameMap; }, [nameMap]);
                const sortedApps = useMemo(() => {
                    const nm = nameRef.current;
                    const keys = Object.fromEntries(appList.map(pkg => [pkg, nm[pkg] || NameResolver.formatFallback(pkg)]));
                    return appList.slice().sort((a, b) => Number((modeIndex[b] || 'default') !== 'default') - Number((modeIndex[a] || 'default') !== 'default') ||
                        (usageTimes[b] || 0) - (usageTimes[a] || 0) || collator.compare(keys[a], keys[b]) || a.localeCompare(b));
                }, [appList, modeIndex, usageTimes, collator]);
                const filtered = useMemo(() => {
                    const query = search.trim().toLocaleLowerCase();
                    return sortedApps.filter(p => (category === 'all' || appTypes[p] === category) &&
                        (!query || p.toLocaleLowerCase().includes(query) || (nameMap[p] || '').toLocaleLowerCase().includes(query)));
                }, [sortedApps, appTypes, category, nameMap, search]);
                const visibleApps = useMemo(() => filtered.slice(0, visibleLimit), [filtered, visibleLimit]);
                const visibleKey = visibleApps.join('\u0000');
                /* 说明：后台补提需要知道完整筛选结果，所以依赖也带上 filtered 的签名。 */
                const filteredKey = filtered.length ? filtered.join('\u0000') : '';
                CP.usePageTask(() => {
                    if (visibleApps.length === 0) return;
                    if (!CP.IconExtractor || typeof CP.IconExtractor.probe !== 'function') return;
                    let alive = true;
                    const controller = new AbortController();
                    let timer = null, missingCount = 0, signature = null;
                    const pendingBg = [];
                    const refresh = async () => {
                        const have = await CP.IconExtractor.probe();
                        if (!alive) return;
                        let missing = 0;
                        visibleApps.forEach(function (p) { if (!have[p]) missing++; });
                        const nextSignature = visibleApps.filter(pkg => have[pkg]).join('\u0000');
                        if (nextSignature && signature !== nextSignature) setIconTick(function (n) { return n + 1; });
                        signature = nextSignature;
                        missingCount = missing;
                        if (!missing && timer) { clearInterval(timer); timer = null; }
                    };
                    (async () => {
                        await refresh();
                        if (!alive) return;
                        /* 说明：提取不绑 signal。图标是持久化资源，提取一次永久受益；
                         * 早期把页面切换的 AbortController 传进来，一快速切页就把队列里
                         * 还没开始的包全部取消（cancel 里 delete attempted + resolve(false)），
                         * 于是「个别图标怎么都加载不出来」——恰好在切页瞬间被取消的那些。 */
                        if (typeof CP.IconExtractor.launch === 'function') {
                            CP.IconExtractor.launch(visibleApps, {});
                            /* 说明：只提交可见的前 30 个是不够的——排在后面的应用永远轮不到提取，
                             * 用户不去搜索它就永远是字母。这里把筛选结果里剩下的也一并提交，
                             * 排在前面的优先（队列 FIFO），后台慢慢补全。 */
                            /* 说明：其余应用同步提交即可——队列自己没有并发风暴风险（每批 4 个），
                             * 用 3 秒延时反而会被切页的 cleanup 清掉，导致后排应用永远补不上图标。 */
                            const rest = filtered.filter(function (p) { return visibleApps.indexOf(p) < 0; });
                            if (rest.length) CP.IconExtractor.launch(rest, {});
                        }
                        if (alive && missingCount && !timer) timer = setInterval(refresh, 4000);
                    })();
                    return () => { alive = false; controller.abort(); if (timer) clearInterval(timer); pendingBg.forEach(clearTimeout); };
                }, [visibleKey, filteredKey]);
                const pull = CP.usePullUpLoad({
                    enabled: !loading && !loadError && filtered.length > visibleLimit,
                    resetKey: search + '\u0000' + category + '\u0000' + reload,
                    /* 说明：一次追加 30 行而不是 60。每行含 AppIcon（颜色计算 + 首字母 + 订阅），
                     * 60 行会在主线程上做一次很重的构建，正好卡在手指刚离开屏幕的那一帧。
                     * 用 startTransition 包住：切页等高优先级更新可以立即打断它。 */
                    onLoad: () => startTransition(function () { setVisibleLimit(n => n + 30); })
                });
                const categories = [['all', '全部'], ['user', '用户应用'], ['system', '系统应用']];
                const status = h('div', { role: saving ? 'status' : undefined, 'aria-live': 'polite', className: 'text-xs text-slate-400 mb-3' },
                    saving ? '正在保存偏好…' : saveError ? '未能应用配置，原配置已保留，请重新选择重试' : '前台应用按所选模式调节CPU；未单独设置的应用跟随默认');

                return h('div', { className: 'flex flex-col min-h-0 h-[calc(100vh-150px)]' }, [
                    /* 说明：默认模式入口：未单独配置的应用按此模式调度 */
                    h('div', { className: 'flex items-center justify-between mb-3 px-1' }, [
                        h('div', {}, [
                            h('div', { className: 'text-xs font-bold text-slate-700 dark:text-slate-300' }, '默认模式'),
                            h('div', { className: 'text-[10px] text-slate-400' }, '省电、均衡、性能、极速四档；按配置文件实际下发')
                        ]),
                        h('button', { disabled: loading || loadError || saving, onClick: () => { setSaveError(false); setShowDefault(true); }, className: 'flex items-center gap-2 disabled:opacity-50' }, [
                            h('span', { className: 'mode-badge ' + (MODE_CLASS[rules.default] || 'mode-default') }, (MODE_LABELS[rules.default] || rules.default).split(' ')[0]),
                            h('span', { className: 'text-slate-400 text-xs' }, '更改 ›')
                        ])
                    ]),
                    h('div', { className: 'flex gap-3 mb-4' }, [
                        h('div', { className: 'flex-1 relative' }, [
                            h(Icon, { name: 'search', className: 'absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400' }),
                            h('input', { type: 'text', value: search, onChange: e => setSearch(e.target.value), placeholder: '搜索应用名/包名...', className: 'w-full bg-white dark:bg-[#1a1a1a] border border-slate-200 dark:border-white/5 rounded-xl pl-9 pr-4 py-3 text-xs focus:ring-2 focus:ring-brand-500/50 outline-none' })
                        ]),
                    ]),
                    h('div', { className: 'flex gap-2 mb-3', role: 'tablist', 'aria-label': '应用分类' }, categories.map(([value, label]) => h('button', {
                        key: value, role: 'tab', 'aria-selected': category === value, onClick: () => setCategory(value),
                        className: 'flex-1 py-2 rounded-xl text-xs font-bold ' + (category === value ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300')
                    }, label + ' ' + appList.filter(p => value === 'all' || appTypes[p] === value).length))),
                    h('div', { className: 'text-[10px] text-slate-400 mb-2 px-1' }, '已配置优先 · 使用时间降序 · 同时长按名称'),
                    h('div', { ref: pull.ref, 'data-app-scroll': true, className: 'flex-1 min-h-0 overflow-y-auto no-scrollbar pb-4', style: { overscrollBehaviorY: 'contain' }, 'aria-busy': loading || pull.phase === 'loading' }, [
                        loading ? h('div', { className: 'cp-app-skeleton', role: 'status', 'aria-label': '正在加载应用列表' }, [
                            h('div', { className: 'flex items-center justify-center gap-2 py-3 text-xs text-slate-400' }, [h('span', { className: 'cp-loading-ring' }), '加载应用列表…']),
                            ...Array.from({ length: 6 }, (_, i) => h('div', { key: i, className: 'cp-skeleton-row', 'aria-hidden': 'true' }, [h('span', { className: 'cp-skeleton-icon' }), h('span', { className: 'cp-skeleton-lines' })]))
                        ]) : loadError ? h('div', { className: 'text-center text-slate-400 mt-10', role: 'alert' }, [
                            h('p', {}, '应用列表或配置读取失败'),
                            h('button', { className: 'mt-3 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs', onClick: () => setReload(n => n + 1) }, '重试')
                        ]) : filtered.length === 0 ? h('div', { className: 'text-center text-slate-400 mt-10' }, '未找到应用') : visibleApps.map(pkg => {
                            const m = getAppMode(pkg);
                            const displayName = nameMap[pkg] || NameResolver.formatFallback(pkg);
                            const isResolving = !nameMap[pkg] && fetchingNames;
                            return h('div', { key: pkg, 'data-app-pkg': pkg, onClick: () => openApp(pkg), className: 'cp-app-row flex items-center p-3 mb-2 bg-white dark:bg-[#121212] rounded-xl border border-slate-100 dark:border-white/5 active:scale-[0.99] transition-transform cursor-pointer' }, [
                                h(AppIcon, { key: 'icon', pkg: pkg, className: 'app-icon mr-3', loadingAnimation: true }),
                                h('div', { className: 'flex-1 min-w-0' }, [
                                    h('div', { className: 'font-bold text-sm text-slate-800 dark:text-slate-200 truncate', title: displayName }, [displayName, isResolving ? h('span', { className: 'cp-name-loading', 'aria-hidden': 'true' }) : null]),
                                    h('div', { className: 'text-[10px] text-slate-400 font-mono truncate', title: pkg }, pkg)
                                ]),
                                h('button', { disabled: saving, onClick: e => { e.stopPropagation(); openApp(pkg); }, className: 'mode-badge shrink-0 whitespace-nowrap ml-2 active:scale-95 transition-transform ' + (m === 'default' ? 'mode-default' : MODE_CLASS[m]), title: '设置应用CPU模式' },
                                    m === 'default' ? '默认·' + (MODE_LABELS[rules.default] || rules.default).split(' ')[0] : MODE_LABELS[m].split(' ')[0])
                            ]);
                        }),
                        !loading && !loadError && filtered.length > visibleLimit ? h('div', {
                            'data-app-pull': pull.phase, role: 'button', tabIndex: 0, onKeyDown: pull.onKeyDown,
                            'aria-label': '上拉或按回车加载更多应用', 'aria-live': 'polite',
                            className: 'flex flex-col items-center justify-center gap-2 py-4 text-xs text-slate-400',
                            style: { minHeight: '72px' }
                        }, [
                            pull.phase !== 'idle' ? h('span', { className: 'cp-loading-ring', 'aria-hidden': true }) : null,
                            h('span', {}, pull.phase === 'loading' ? '加载更多应用…' : pull.phase === 'armed' ? '松手加载更多应用' : '滑到底部后继续上拉加载'),
                            h('span', {}, '已显示 ' + Math.min(visibleLimit, filtered.length) + ' / ' + filtered.length)
                        ]) : !loading && !loadError && filtered.length ? h('div', { className: 'text-center py-4 text-xs text-slate-400', 'data-app-end': true }, '已显示全部 ' + filtered.length + ' 个应用') : null
                    ]),
                    selectedPkg ? h('div', { className: 'fixed inset-0 z-50 flex items-end bg-black/40', onClick: closePanel, role: 'dialog', 'aria-modal': 'true', 'aria-label': '应用模式配置' }, [
                        h('div', { 
                            className: 'w-full bg-white dark:bg-[#1e1e1e] rounded-t-3xl p-6 pb-28 max-h-[90vh] overflow-y-auto no-scrollbar animate-[slideUp_0.3s_ease-out]', 
                            onClick: e => e.stopPropagation() 
                        }, [
                            h('div', { className: 'flex items-center gap-3 mb-4' }, [
                                h(AppIcon, { pkg: selectedPkg, className: 'app-icon', loadingAnimation: true }),
                                h('div', { className: 'flex-1' }, [
                                    h('div', { className: 'font-bold text-lg text-slate-800 dark:text-white truncate' }, nameMap[selectedPkg] || NameResolver.formatFallback(selectedPkg)),
                                    h('div', { className: 'text-xs text-slate-400 font-mono' }, selectedPkg)
                                ]),
                                h('button', { disabled: saving, onClick: closePanel, 'aria-label': '关闭', className: 'text-slate-400 p-2 bg-slate-100 dark:bg-slate-700 rounded-full' }, '✕')
                            ]),
                            status,
                            h('div', { className: 'grid grid-cols-2 gap-3' }, ['default'].concat(MODES).map(m => h('button', { key: m, disabled: saving, style: m === 'default' ? { gridColumn: '1 / -1' } : undefined, onClick: () => setMode(selectedPkg, m), className: 'p-3 rounded-xl text-left border transition-all ' + (getAppMode(selectedPkg) === m ? ((m === 'default' ? 'mode-default' : MODE_CLASS[m]) + ' ring-2 ring-current ring-opacity-50') : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800') }, [
                                h('div', { className: 'text-xl mb-1' }, m === 'default' ? '↩' : MODE_LABELS[m].split(' ')[1] || ''),
                                h('div', { className: 'font-bold text-sm' }, m === 'default' ? '跟随默认' : MODE_LABELS[m].split(' ')[0] || m),
                                m === 'default' ? h('div', { className: 'text-[10px] opacity-60 mt-1' }, '当前：' + MODE_LABELS[rules.default].split(' ')[0]) : null
                            ]))),
                        ])
                    ]) : null,
                    showDefault ? h('div', { className: 'fixed inset-0 z-50 flex items-end bg-black/40', onClick: closePanel, role: 'dialog', 'aria-modal': 'true', 'aria-label': '默认模式' }, [
                        h('div', {
                            className: 'w-full bg-white dark:bg-[#1e1e1e] rounded-t-3xl p-6 pb-28 max-h-[80vh] overflow-y-auto no-scrollbar animate-[slideUp_0.3s_ease-out]',
                            onClick: e => e.stopPropagation()
                        }, [
                            h('div', { className: 'flex items-center justify-between mb-4' }, [
                                h('div', { className: 'font-bold text-base text-slate-800 dark:text-white' }, '选择默认模式'),
                                h('button', { disabled: saving, onClick: closePanel, 'aria-label': '关闭', className: 'text-slate-400 p-2 bg-slate-100 dark:bg-slate-700 rounded-full' }, '✕')
                            ]),
                            status,
                            h('div', { className: 'grid grid-cols-2 gap-3' }, MODES.map(m => h('button', { key: m, disabled: saving, onClick: () => { if (rules.default === m) closePanel(); else commit({ ...rules, default: m }); }, className: 'p-3 rounded-xl text-left border transition-all ' + (rules.default === m ? (MODE_CLASS[m] + ' ring-2 ring-current ring-opacity-50') : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800') }, [
                                h('div', { className: 'text-xl mb-1' }, MODE_LABELS[m].split(' ')[1] || ''),
                                h('div', { className: 'font-bold text-sm' }, MODE_LABELS[m].split(' ')[0] || m)
                            ])))
                        ])
                    ]) : null,
                ]);
            };

  CP.AppManager = AppManager;
})(window.CP = window.CP || {});