(function (CP) {
  'use strict';
  const h = CP.h;
  const KsuService = CP.KsuService;
  const Icon = CP.Icon;
  const MODES = CP.MODES;
  const BatteryPage = CP.BatteryPage;
  const AppManager = CP.AppManager;
  const LogViewer = CP.LogViewer;
  const StatusPage = CP.StatusPage;

  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useMemo = React.useMemo, useCallback = React.useCallback;

/* 说明：页面实例保活；路由壳立即切换，重组件挂载和读取只在加载壳绘制之后开始。 */
const PageBody = React.memo(function (props) { return h(props.component); });
/* 说明：warmMs 是「预热窗口」——组件挂载后允许后台取数的时长，到点收回预热态，
 * 避免后台常驻轮询。耗电页要读整份历史 JSON，窗口放宽。 */
const ROUTES = [{id:'status',label:'状态',icon:'activity',component:StatusPage},{id:'battery',label:'耗电',icon:'battery',component:BatteryPage,warmMs:9000},{id:'apps',label:'应用',icon:'grid',component:AppManager},{id:'config',label:'配置',icon:'settings',component:CP.ConfigPage},{id:'logs',label:'日志',icon:'file-text',component:LogViewer}];
/* 说明：启动之后的预热顺序，便宜的先做、昂贵的最后做。
 * 状态页是首屏，不在这里（它由启动页直接等）。 */
const WARM_ORDER = ['config', 'logs', 'apps', 'battery'];
/* 说明：导航栏高亮不走 React 渲染——点击时直接改 DOM 的 is-active 类。
 * 这样文字变色与图标胶囊在事件回调里立刻生效，与浏览器原生的 :active 背景同一帧，
 * 不会被页面首次构建或 transition 调度拖慢。React 状态只用于后续保持一致。 */
const BottomNavigation = React.memo(function (props) {
    return h('nav', { ref: props.navRef, className: 'cp-bottom-nav', role: 'tablist', 'aria-label': '页面导航' },
        ROUTES.map(route => h('button', {
            key: route.id, id: 'tab-' + route.id, type: 'button', role: 'tab',
            'data-nav-tab': route.id, 'aria-controls': 'page-' + route.id,
            'aria-selected': props.selected === route.id,
            /* 说明：切页在 pointerdown 就完成，不再等 click。
             * 惯性滚动期间浏览器可能延迟甚至吞掉 click（避免误触），
             * 但 pointerdown 一定会在按下瞬间派发——这正是「滚动中点了没反应」的根源。
             * click 仍保留为兜底（键盘回车、无障碍触发走它），navigate 内部有幂等判断。 */
            onPointerDown: () => props.onNavigate(route.id),
            onClick: () => props.onNavigate(route.id),
            className: 'cp-nav-button' + (props.selected === route.id ? ' is-active' : '')
        }, [h('span', { className: 'cp-nav-icon', 'aria-hidden': true },
                h(Icon, { name: route.icon, className: 'w-5 h-5' })),
            h('span', { className: 'cp-nav-label' }, route.label)])));
});
/* 说明：加载浮层与滚动容器为同级，且层级低于悬浮栏——遮罩只盖页面，永远不盖导航。
 * 首次进入盖全屏遮罩；再次切回只显示顶部细进度条，立即展示已有内容。 */
const PageFrame = React.memo(function (props) {
    const route = props.route, active = props.active, warm = props.warm;
    const scope = useMemo(() => CP.createPageScope(false), []);
    const [mounted, setMounted] = useState(false);
    /* 说明：不用 useSyncExternalStore——它会让 React 18 退化成同步渲染，startTransition
     * 的可打断能力失效，切页时整棵树同步提交把主线程占满。这里用普通状态 + 订阅。 */
    const [busyState, setBusyState] = useState(function () {
        return { loading: scope.isLoading(), first: scope.isFirstLoading() };
    });
    React.useEffect(function () {
        return scope.subscribeLoading(function () {
            setBusyState({ loading: scope.isLoading(), first: scope.isFirstLoading() });
            /* 说明：首次数据到齐即向启动页报告本页就绪，用于收起全屏加载页。 */
            if (!scope.isFirstLoading() && props.onReady) props.onReady(route.id);
        });
    }, [scope, route.id, props.onReady]);
    const dataLoading = busyState.loading, firstLoading = busyState.first;
    React.useLayoutEffect(() => {
        CP.diagLog('frame_layout', route.id + ' active=' + (active ? 1 : 0) + ' mounted=' + (mounted ? 1 : 0));
        if (!active) { scope.setActive(false); return; }
        if (mounted) return;
        /* 说明：让当前帧先把悬浮栏高亮和页面壳画出来，重组件挂载推到下一个任务，
         * 避免点击的那一帧被组件树构建占满。 */
        const timer = setTimeout(function () { setMounted(true); }, 0);
        return function () { clearTimeout(timer); };
    }, [active, mounted, scope]);
    useEffect(() => {
        if (!active || !mounted) return;
        scope.setWarm(false);
        scope.setActive(true);
        return () => { scope.setActive(false); };
    }, [active, mounted, scope]);
    /* 说明：预热。组件提前挂载并读一次数据，用户真点进来时页面已完整，
     * 切换只剩 display 变化。用 ref 防重入——不能把 mounted 放进依赖，
     * 否则 mounted 一变 cleanup 就会把 warming 立刻关掉，预热等于没做。 */
    const warmStarted = useRef(false);
    useEffect(() => {
        if (!warm || warmStarted.current || active) return;
        warmStarted.current = true;
        setMounted(true);
        scope.setWarm(true);
        /* 说明：给页面留出读数窗口；数据到齐后收回预热态，避免后台常驻轮询。
         * v2.5.4：窗口长度按页配置（route.warmMs），耗电页读整份历史 JSON 需要更长时间，
         * 固定 3 秒会在读完之前就收回预热、把读取中断在半路。 */
        const timer = setTimeout(function () { scope.setWarm(false); }, route.warmMs || 3000);
        return function () { clearTimeout(timer); scope.setWarm(false); };
    }, [warm, active, scope]);
    useEffect(() => () => scope.dispose(), [scope]);
    const showOverlay = active && firstLoading && dataLoading;
    /* 说明：页面的可见性完全交给 CSS class（is-hidden / is-active），不再使用 hidden 属性。
     * 原因：hidden 同时被 React 与 navigate 的 DOM 直写管理，两边会互相覆盖——
     * 惯性滚动期间 React 提交被推迟，它按旧状态重渲染时会把直写的 hidden 改回去，
     * 表现就是「悬浮栏切了、页面没切」。改用 class 后 React 只负责初值，
     * 运行时切换只由 applyPage 一个地方写入，不存在竞争。 */
    return h('section', { className: 'cp-page-frame' + (active ? ' is-active' : ' is-hidden'),
        'aria-hidden': !active,
        'data-page-frame': route.id, 'aria-busy': active && dataLoading }, [
        active && dataLoading && !showOverlay ? h('div', { className: 'cp-page-progress', 'aria-hidden': true }) : null,
        h('main', { id: 'page-' + route.id, role: 'tabpanel', 'aria-labelledby': 'tab-' + route.id,
            'aria-hidden': !active || showOverlay, inert: !active || showOverlay ? '' : undefined,
            'data-page-main': '', className: 'cp-page w-full max-w-md px-5 pt-8 overflow-y-auto relative z-10 pb-28' },
            h(CP.PageActiveContext.Provider, { value: scope }, mounted ? h(PageBody, { component: route.component }) : null)),
        showOverlay ? h('div', { className: 'cp-page-loading', role: 'status', 'aria-live': 'polite',
            'data-page-loader': route.id }, [h('span', { className: 'cp-loading-ring', 'aria-hidden': true }),
            h('strong', null, route.label + '页面加载中…'), h('span', null, '可以随时切换其他页面')]) : null
    ]);
});
const App = () => {
                /* 说明：navTab 只用于后续渲染保持一致；点击当下的高亮由 applyHighlight 直接改 DOM。 */
                const [navTab, setNavTab] = useState('status');
                const [renderTab, setRenderTab] = useState('status');
                /* 说明：ready 为 false 时显示全屏启动页（盖住悬浮栏）；warmDone 记录各页首载完成。
                 * 预热不再是一个集合——同一时刻只有一页在预热，见下面的 warmStep。 */
                const [warmDone, setWarmDone] = useState({});
                const [ready, setReady] = useState(false);
                const markReady = useCallback(function (id) {
                    setWarmDone(function (prev) { return prev[id] ? prev : Object.assign({}, prev, { [id]: true }); });
                }, []);
                const current = useRef('status');
                const navRef = useRef(null);
                /* 说明：同步切换导航高亮。纯 DOM 操作，不排 React 队列，
                 * 保证文字变色与图标胶囊和浏览器原生 :active 背景同一帧生效。 */
                const applyHighlight = useCallback(function (id) {
                    var nav = navRef.current;
                    if (!nav) return;
                    var buttons = nav.querySelectorAll('[data-nav-tab]');
                    for (var i = 0; i < buttons.length; i++) {
                        var on = buttons[i].getAttribute('data-nav-tab') === id;
                        if (on) buttons[i].classList.add('is-active');
                        else buttons[i].classList.remove('is-active');
                        buttons[i].setAttribute('aria-selected', on ? 'true' : 'false');
                    }
                }, []);
                /* 说明：页面显隐也直接改 DOM，不依赖 React 调度。
                 * 惯性滚动（用力一滑之后的动量滚动）期间浏览器会把主线程预算优先给合成与滚动，
                 * React 的提交可能被推迟到滚动结束——这正是「滚动没停时点切换，悬浮栏变了页面没变」
                 * 的原因。所有页面在启动加载页期间已全部挂载，切页只是 hidden 属性切换，
                 * 直接写 DOM 既安全又不受调度影响。 */
                const applyPage = useCallback(function (id) {
                    var frames = document.querySelectorAll('[data-page-frame]');
                    for (var i = 0; i < frames.length; i++) {
                        var on = frames[i].getAttribute('data-page-frame') === id;
                        frames[i].classList.toggle('is-active', on);
                        frames[i].classList.toggle('is-hidden', !on);
                        frames[i].setAttribute('aria-hidden', on ? 'false' : 'true');
                        var main = frames[i].querySelector('[data-page-main]');
                        if (main) {
                            if (on) main.removeAttribute('inert');
                            else main.setAttribute('inert', '');
                        }
                    }
                }, []);
                const navigate = useCallback(id => {
                    if (current.current === id || !ROUTES.some(route => route.id === id)) return;
                    CP.diagLog('nav_begin', id + ' scrolling=' + (window.__cpScrolling ? 1 : 0));
                    current.current = id;
                    /* 说明：两步都是同步 DOM 直写，滚动惯性期间也能立刻上屏；
                     * 之后再更新 React 状态，让 aria 与内部数据保持一致。 */
                    applyHighlight(id);
                    applyPage(id);
                    CP.diagLog('nav_dom_done', 'frames=' + document.querySelectorAll('[data-page-frame]').length +
                               ' active=' + document.querySelectorAll('[data-page-frame].is-active').length);
                    setNavTab(id);
                    setRenderTab(id);
                    CP.diagLog('nav_state_queued', id);
                }, [applyHighlight, applyPage]);
                /* 说明：v2.5.4 启动策略——启动页只等「当前可见页」首载完成。
                 * 旧做法要等五页全部就绪，再额外留 900ms 收尾、兜底 8 秒；
                 * 而每页的预热窗口只有 3 秒，耗电页的分块读取与应用图标提取经常做到一半就被收回，
                 * warmDone 于是永远凑不齐，启动页几乎每次都等满 8 秒兜底——这就是「预加载太久」。
                 * 现在：状态页一就绪立即收起启动页（1.2 秒硬兜底），其余页面在收起之后分批预热。 */
                useEffect(() => {
                    if (ready) return;
                    if (warmDone.status) { setReady(true); return; }
                    const limit = setTimeout(function () { setReady(true); }, 1200);
                    return function () { clearTimeout(limit); };
                }, [warmDone, ready]);
                /* 说明：分阶段预热。启动页收起后按「便宜 → 昂贵」逐页挂载取数，
                 * 同一时刻只有一页在预热，避免五页同时把同步 sh 桥接排成长队。 */
                const _ws = useState(-1), warmStep = _ws[0], setWarmStep = _ws[1];
                useEffect(() => {
                    if (!ready) return;
                    const timer = setTimeout(function () { setWarmStep(0); }, 200);
                    return function () { clearTimeout(timer); };
                }, [ready]);
                const warmId = warmStep >= 0 && warmStep < WARM_ORDER.length ? WARM_ORDER[warmStep] : null;
                useEffect(() => {
                    if (!warmId) return;
                    const route = ROUTES.filter(function (r) { return r.id === warmId; })[0];
                    const budget = (route && route.warmMs) || 3000;
                    /* 说明：本页首载完成就提前推进，不必等满预算。 */
                    const advance = function () { setWarmStep(function (prev) { return prev === warmStep ? prev + 1 : prev; }); };
                    const timer = setTimeout(advance, warmDone[warmId] ? 120 : budget);
                    return function () { clearTimeout(timer); };
                }, [warmId, warmStep, warmDone]);
                useEffect(() => {
                    CP.goTab = navigate;
                    return () => { if (CP.goTab === navigate) delete CP.goTab; };
                }, [navigate]);
                const [toast, setToast] = useState({ msg: '', visible: false });

                useEffect(() => {
                    let timer;
                    const show = msg => {
                        clearTimeout(timer); setToast({ msg, visible: true });
                        timer = setTimeout(() => setToast(p => ({...p, visible: false})), 2500);
                    };
                    window.showToast = show;
                    return () => { clearTimeout(timer); if (window.showToast === show) delete window.showToast; };
                }, []);

                return h('div', { className: 'w-full relative flex flex-col items-center overflow-hidden h-screen' }, [
                    h('div', { className: 'absolute top-12 left-1/2 -translate-x-1/2 glass-panel bg-slate-900/90 dark:bg-white/90 text-white dark:text-slate-900 px-5 py-2.5 rounded-full shadow-2xl z-[100] flex items-center gap-2 transition-all duration-400 ' + (toast.visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-8 scale-95 pointer-events-none') }, [
                        h(Icon, { name: 'bell', className: 'w-4 h-4' }),
                        h('span', { className: 'text-[13px] font-bold' }, toast.msg)
                    ]),
                    h('div', { className: 'cp-page-stack' }, ROUTES.map(route =>
                        h(PageFrame, { key: route.id, route: route, active: renderTab === route.id,
                                       warm: warmId === route.id, onReady: markReady }))),
                    h(BottomNavigation, { selected: navTab, onNavigate: navigate, navRef: navRef }),
                    /* 说明：启动加载页。z-index 高于悬浮栏，整屏盖住（含导航），
                     * 转圈用 transform 动画走合成线程，主线程被 sh 占住时仍能正常旋转。 */
                    ready ? null : h('div', { className: 'cp-boot', role: 'status', 'aria-live': 'polite' }, [
                        h('span', { className: 'cp-boot-ring', 'aria-hidden': true }),
                        h('strong', { className: 'cp-boot-title' }, '正在加载'),
                        h('span', { className: 'cp-boot-hint' }, '正在读取运行状态…')
                    ])
                ]);
            };



  CP.App = App;

  /* 说明：挂载应用并关闭启动骨架。 */
  try {
    var rootEl = document.getElementById('root');
    if (rootEl && window.ReactDOM && ReactDOM.createRoot) {
      ReactDOM.createRoot(rootEl).render(h(App));
      var sk = document.getElementById('skeleton');
      if (sk) sk.style.display = 'none';
    }
  } catch (e) {
    console.error(e);
    var sk2 = document.getElementById('skeleton');
    if (sk2) sk2.innerHTML = '<div style="color:#ef4444;padding:24px;text-align:center;font-size:14px;line-height:1.6;max-width:90%;">⚠️ 引擎加载失败: ' + e.message + '<br><br>请检查 ./lib/ 文件完整性</div>';
  }

})(window.CP = window.CP || {});