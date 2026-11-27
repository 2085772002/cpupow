/* 说明：只读状态页；串行轮询，隐藏与卸载时停止，读取失败立即撤销正常标记。 */
(function (CP) {
    'use strict';
    const h = CP.h;
    CP.StatusPage = function () {
        const [value, setValue] = React.useState(null), [error, setError] = React.useState('');
        const [loading, setLoading] = React.useState(true), [updated, setUpdated] = React.useState('');
        const request = React.useRef(null);
        /* 说明：记录上次成功读取的时间。切回本页时若数据还新鲜就直接用缓存，
         * 不再立刻跑一次 status.sh——ksu.exec 是同步桥接，每跑一次都会占住主线程。 */
        const lastOk = React.useRef(0);
        CP.usePageLoading(loading && !value && !error);
        CP.usePageTask(function () {
            let alive = true, busy = false, timer = null;
            const POLL_MS = 8000;      /* 说明：轮询本身会同步阻塞几十毫秒，间隔放宽到 8 秒 */
            const FRESH_MS = 12000;    /* 说明：切回本页时若数据 12 秒内有效，完全不起新的 sh */
            const run = async () => {
                if (!alive || busy || document.hidden) return;
                clearTimeout(timer); busy = true; setLoading(true);
                try {
                    const result = await CP.KsuService.readRuntimeStatus();
                    if (alive) { setValue(result); setError(''); setUpdated(new Date().toLocaleTimeString()); lastOk.current = Date.now(); }
                } catch (e) {
                    if (alive) { setValue(null); setError(e.message || '运行状态读取失败'); }
                } finally {
                    busy = false;
                    if (alive) { setLoading(false); if (!document.hidden) arm(POLL_MS); }
                }
            };
            /* 说明：所有读取都推到浏览器绘制之后，避免在用户点击/滚动的那一帧占住主线程。 */
            const poll = () => { CP.afterPaint(function () { if (alive) run(); }); };
            const arm = ms => { clearTimeout(timer); timer = setTimeout(function () { CP.afterPaint(function () { if (alive) run(); }); }, ms); };
            const visibility = () => { clearTimeout(timer); if (!document.hidden) poll(); };
            request.current = poll;
            document.addEventListener('visibilitychange', visibility);
            const age = Date.now() - lastOk.current;
            if (lastOk.current && age < FRESH_MS) arm(Math.max(1000, POLL_MS - age));
            else poll();
            return () => { alive = false; clearTimeout(timer); request.current = null; document.removeEventListener('visibilitychange', visibility); };
        }, []);
        const state = CP.RuntimeHealth.summarize(value);
        const row = (label, text) => h('div', { key: label, className: 'flex gap-4 justify-between py-3 border-b border-slate-100 dark:border-white/5' }, [
            h('dt', { className: 'text-slate-400 shrink-0' }, label), h('dd', { className: 'text-right break-all' }, text)
        ]);
        const runtime = value && value.runtime;
        return h('section', { 'data-status-page': true, 'aria-busy': loading, className: 'pb-3' }, [
            h('div', { className: 'flex items-center justify-between mb-5' }, [
                h('h1', { className: 'text-2xl font-black' }, '运行状态'),
                h('button', { disabled: loading, onClick: () => { if (request.current) request.current(); }, className: 'rounded-xl px-4 py-2 bg-white dark:bg-slate-900 text-xs border border-slate-200 dark:border-white/10 disabled:opacity-50' }, loading ? '检查中…' : '刷新状态')
            ]),
            h('div', { role: error ? 'alert' : 'status', 'aria-live': 'polite', 'data-health': error ? 'unknown' : state.tone,
                className: 'rounded-3xl p-5 mb-4 border ' + (state.tone === 'ok' && !error ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300' : 'bg-slate-100 border-slate-200 dark:bg-slate-900 dark:border-slate-800') }, [
                h('div', { className: 'flex items-center gap-2 text-lg font-black' }, [loading ? h('span', { className: 'cp-loading-ring', 'aria-hidden': true }) : h(CP.Icon, { name: 'activity', className: 'w-5 h-5' }), error ? '状态读取失败' : state.label]),
                h('p', { className: 'mt-2 text-xs leading-6' }, error || state.detail),
                h('p', { className: 'mt-2 text-[10px] opacity-70' }, updated ? '最近成功检查 ' + updated + ' · 每 5 秒自动刷新' : '等待首次检查')
            ]),
            h('dl', { className: 'rounded-2xl bg-white dark:bg-[#121212] px-4 text-xs' }, [
                row('守护进程', value ? value.daemon.running ? '运行中 · PID ' + value.daemon.pid : '未运行' : '未知'),
                row('自动拉起监控', value ? value.watchdog.running ? '运行中' : '未运行' : '未知'),
                row('策略配置', runtime ? runtime.config_valid ? '有效 · 修订 ' + runtime.config_revision : '无效，禁止继续写入' : '未知'),
                row('当前模式', runtime ? CP.MODE_LABELS[runtime.mode] || runtime.mode : '未知'),
                row('前台应用', runtime ? runtime.package || '未识别' : '未知'),
                row('触摸监听', runtime ? runtime.touch_available ? '可用' : '不可用' : '未知'),
                row('日志级别', runtime ? ['仅致命', '简约', '详细', '超详细'][runtime.log_level] || '未知' : '未知'),
                row('各集群频率', runtime && runtime.frequencies ? runtime.frequencies.split(',').map(function(s){var p=s.split(':');return '策略'+p[0]+' '+(Number(p[1])/1000).toFixed(0)+' MHz';}).join(' · ') : '未采集'),
                row('主循环心跳', runtime ? Math.max(0, Math.floor(value.checked_uptime_s - runtime.uptime_s)) + ' 秒前' : '未知')
            ]),
            h('div', { className: 'rounded-2xl mt-4 p-4 bg-white dark:bg-[#121212] text-xs leading-6' }, [
                h('h2', { className: 'font-bold mb-1' }, '策略写入与读回'),
                h('p', {}, CP.RuntimeHealth.policy(value)),
                h('p', { className: 'text-slate-400 mt-2' }, '回执是最近一次观察，不代表硬件始终保持该数值；程序健康与参数实际效果分开显示。')
            ])
        ]);
    };
})(window.CP = window.CP || {});