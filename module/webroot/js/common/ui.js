/* 说明：ui.js — 图标组件与模式常量 */
(function () {
    'use strict';
    var h = CP.h;

    var IconPaths = {
        grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
        search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
        'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
        'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
        cpu: '<rect width="16" height="16" x="4" y="4" rx="2" ry="2"/><rect width="6" height="6" x="9" y="9" rx="1" ry="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
        settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        'chevron-down': '<path d="m6 9 6 6 6-6"/>',
        /* 说明：v1.21.4：周期管理浮层的删除按钮 */
        'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
        'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
        sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
        target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
        refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
        compare: '<path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>',
        activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="11" x2="6" y2="13"/><line x1="10" y1="11" x2="10" y2="13"/><line x1="14" y1="11" x2="14" y2="13"/>'
    };

    var Icon = function (props) {
        return h('svg', {
            xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', className: props.className,
            dangerouslySetInnerHTML: { __html: IconPaths[props.name] || '<circle cx="12" cy="12" r="10"/>' }
        });
    };

    /* 说明：v1.26.4 AppIcon：应用图标统一渲染（公共内核层——views 不得各自造 img/首字母分支）
 * v1.26.3 修的是「有没有 <img> 节点」，本次修的是「这个节点解码完了没有」。
 * 用户反馈：「下划栏点击应用配置模式页面的时候图标会在加载的时候闪一下」——
 * 切 Tab 时 app.js 的 main[key=tab] 让整棵树重挂载，AppIcon 全部重建：
 * ① 白名单命中只代表「PNG 存在」，新 img 节点仍要重新加载/解码，
 * 解码完成前这一层是透明的，露出首字母色块，解码一到图标「啪」地覆盖；
 * ② 名字解析期间图标上还盖着 .loading-dot 半透明黑罩，解析完再撤，
 * 又是一次可见变化。
 * 现做法：
 * · 先由 IconExtractor.decode() 把 PNG 解码完并池化 Image 对象，
 * decode 返回 true 才渲染 <img>——同 URL 命中已解码资源，插入即上屏，
 * 不存在「色块 → 图标」之间的透明帧；
 * · 首字母色块保留为底层，只在解码未完成时可见；
 * · 失败短暂退避；文件提取完成后解除失败，支持迟到与重试。
 */
    var AppIcon = function (props) {
        var pkg = props.pkg || '';
        var scope = CP.usePageScope();
        var IE = CP.IconExtractor || {};
        /* 说明：初始态直接读内核层：池里已就绪的包首帧就渲染 img，连一次 setState 都省掉 */
        var _s = React.useState(function () {
            return { bad: !!(IE.hasFailed && IE.hasFailed(pkg)), ready: !!(IE.isReady && IE.isReady(pkg)) };
        });
        var st = _s[0], setSt = _s[1];
        /* 说明：图标完成通知必须用普通 useEffect 订阅，不能走 usePageTask。
         * usePageTask 在页面不活跃时直接跳过——那样订阅根本没建立，
         * 提取完成后的 _notify 没有任何人接收，AppIcon 也就不会重渲染，
         * needDecode 永远是 false，解码永不触发。这正是 21 个包长期停在
         * 「known(有文件待解码)」的原因。 */
        React.useEffect(function () {
            if (!IE.subscribe) return undefined;
            return IE.subscribe(function (p) {
                if (p === pkg) setSt({ bad: !!IE.hasFailed(pkg), ready: !!IE.isReady(pkg) });
            });
        }, [pkg]);
        /* 说明：换包时重算一次，别把上一个包的失败/就绪状态带过来 */
        React.useEffect(function () {
            setSt({ bad: !!(IE.hasFailed && IE.hasFailed(pkg)), ready: !!(IE.isReady && IE.isReady(pkg)) });
        }, [pkg]);

        /* 说明：渲染期直接读内核层：known 是 probe 回来后才更新的，父组件 setIconTick 重渲染时
 * 这里就能拿到最新值；needDecode 由 false 变 true 会重新触发下面的 effect，
 * 否则 AppIcon 只在挂载那一刻试一次，白名单后到就永远不加载图标。
 */
        var hasIcon = !!(IE.hasIcon && IE.hasIcon(pkg));
        var badNow = st.bad || !!(IE.hasFailed && IE.hasFailed(pkg));
        var readyNow = st.ready || !!(IE.isReady && IE.isReady(pkg));
        var needDecode = !badNow && !readyNow && hasIcon;

        /* 说明：图标解码改用普通 useEffect，不再走 usePageTask。
         * usePageTask 面向「读设备数据」的任务：它会在页面不活跃时跳过、切换时取消、
         * 并在执行前等两帧 + 120ms。图标解码是纯前端资源（读本地 PNG），
         * 这三条约束全是负担——尤其「不活跃就跳过」会让切页后 28 个包一直停在
         * known（有文件待解码）状态，永远不显示图标。 */
        React.useEffect(function () {
            var alive = true;
            if (!needDecode || !IE.decode) return undefined;
            IE.decode(pkg).then(function (okv) {
                if (!alive) return;
                setSt({ bad: !okv, ready: !!okv });
            }).catch(function () {
                if (alive) setSt({ bad: true, ready: false });
            });
            return function () { alive = false; };
        }, [pkg, needDecode]);

        var fail = function () {
            if (IE.markFailed) IE.markFailed(pkg);
            setSt({ bad: true, ready: false });
        };
        var showImg = !badNow && readyNow;
        var wait = React.useState(false), expired = wait[0], setExpired = wait[1];
        React.useEffect(function () {
            setExpired(false);
            if (!props.loadingAnimation || readyNow || badNow) return undefined;
            /* 说明：仅限制视觉等待；后台提取继续，迟到图标仍可正常显示。 */
            var timer = setTimeout(function () { setExpired(true); }, 30000);
            return function () { clearTimeout(timer); };
        }, [pkg, props.loadingAnimation, readyNow, badNow]);
        /* 说明：超时后不再一律退回首字母——只要这个包还在提取队列里
         * （说明后台仍在处理，只是还没轮到），就继续显示加载环。
         * 只有明确失败（badNow）或确实没在排队时才显示字母，
         * 这样「转圈转完了还是字母」不会出现在真正会成功的包上。 */
        var inFlight = !!(IE.pending && IE.pending(pkg));
        var pending = !!props.loadingAnimation && !showImg && !badNow && (!expired || inFlight);
        var initial = React.useRef({ pkg: pkg, ready: readyNow });
        if (initial.current.pkg !== pkg) initial.current = { pkg: pkg, ready: !!(IE.isReady && IE.isReady(pkg)) };
        return h('div', {
            /* 说明：图标就绪后撤掉彩色底。彩色底与首字母阴影会从图片的圆角抗锯齿边缘、
             * 以及图标 PNG 自带的透明角里透出来，表现为图标四周一圈异色。 */
            'data-app-icon': pkg,
            className: 'relative overflow-hidden flex items-center justify-center ' +
                (showImg ? 'cp-icon-ready ' : CP.getPkgColor(pkg) + ' ') + (props.className || ''),
            style: props.style
        }, [
            h('span', {
                key: 'ini',
                className: 'leading-none',
                /* 说明：首字母带 text-shadow(0 1px 2px)，阴影向外扩散 2px，
                 * 图片覆盖不严时正好从边缘渗出，是「边缘发暗」的另一个来源。 */
                style: showImg ? { visibility: 'hidden' } : undefined
            }, CP.getInitials(pkg)),
            showImg ? h('img', {
                key: 'img',
                src: 'icons/' + encodeURIComponent(pkg) + '.png',
                alt: '',
                className: 'absolute inset-0 w-full h-full object-cover cp-icon-img' +
                    (props.loadingAnimation && !initial.current.ready ? ' cp-icon-reveal' : ''),
                onLoad: function (e) {
                    /* 说明：全局兜底会把失败 img 的 src 换成 data: 占位图，这种 onLoad 不算真图标 */
                    var el = e && e.currentTarget;
                    if (el && String(el.src || '').indexOf('data:') === 0) fail();
                },
                onError: fail
            }) : null,
            pending ? h('span', { key: 'loading', className: 'cp-icon-loading', role: 'status', 'aria-label': '正在加载应用图标' }, h('span', { className: 'cp-loading-ring', 'aria-hidden': 'true' })) : null,
            props.children || null
        ]);
    };

    var MODES = ['powersave', 'balance', 'performance', 'fast'];
    var MODE_LABELS = { powersave: '省电 ⚡️', balance: '均衡 ⚖️', performance: '性能 🚀', fast: '极速 🔥' };
    var MODE_CLASS = { powersave: 'mode-save', balance: 'mode-bal', performance: 'mode-perf', fast: 'mode-fast' };

    /* 说明：v1.15.0 问号提示：包在文字外即可让专业名词/截断包名可点按查看说明。
 * 用法：h(Tip, { body: '说明文字' }, '名词')  —— 触摸端点按展开，桌面端悬停展开
 */
    var Tip = function (props) {
        return h('span', { className: 'tip' }, [
            props.children,
            h('span', { className: 'tip-body' }, props.body || '')
        ]);
    };

    /* 说明：术语问号：行内小圆点 ?，点按展开解释（用于图表口径、配置项命名） */
    var TipQ = function (props) {
        return h('span', { className: 'tip' }, [
            h('button', { type: 'button', className: 'tip-q', 'aria-label': '说明' }, '?'),
            h('span', { className: 'tip-body' }, props.body || '')
        ]);
    };

    CP.Icon = Icon;
    CP.AppIcon = AppIcon;
    CP.MODES = MODES;
    CP.MODE_LABELS = MODE_LABELS;
    CP.MODE_CLASS = MODE_CLASS;
    CP.Tip = Tip;
    CP.TipQ = TipQ;
})();