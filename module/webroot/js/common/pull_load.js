/* 说明：底部上拉分页的公共交互；只有到达末尾后继续上拉并松手才提交一页。 */
(function (CP) {
    'use strict';
    const threshold = 56;
    CP.usePullUpLoad = function (options) {
        const ref = React.useRef(null), latest = React.useRef(options);
        const scope = CP.usePageScope();
        const [state, setState] = React.useState({ phase: 'idle', distance: 0 });
        latest.current = options;
        CP.usePageTask(function () {
            const node = ref.current;
            if (!node) return;
            let start = null, distance = 0, busy = false, alive = true, timer = null;
            const atBottom = () => node.scrollHeight - node.clientHeight - node.scrollTop <= 3;
            const reset = () => { start = null; distance = 0; if (alive) setState({ phase: 'idle', distance: 0 }); };
            const load = () => {
                if (busy || !latest.current.enabled) return;
                busy = true;
                setState({ phase: 'loading', distance: 24 });
                /* 说明：保留一帧可见加载反馈，并在切页、筛选变化时取消未提交任务。 */
                /* 说明：原来固定等 180ms 才提交，用户感知就是「手指抬起后卡一下」。
                 * 现在只留一帧（50ms）让加载态上屏，随即提交；真正的重活由调用方
                 * 用 startTransition 降到低优先级，可被切页打断。 */
                timer = setTimeout(() => {
                    if (!alive) return;
                    Promise.resolve().then(() => latest.current.onLoad()).catch(() => {
                        if (CP.KsuService) CP.KsuService.toast('应用加载失败，请重新上拉');
                    }).finally(() => { busy = false; if (alive) reset(); });
                }, 50);
            };
            const begin = event => {
                if (busy || !latest.current.enabled || event.touches.length !== 1) { reset(); return; }
                start = atBottom() ? event.touches[0].clientY : null;
                distance = 0;
            };
            const move = event => {
                if (busy || !latest.current.enabled) return;
                if (event.touches.length !== 1) { reset(); return; }
                /* 说明：start 只在 touchstart 且已到底时才被赋值。
                 * 这里绝不能再调 atBottom()——它读 scrollHeight/clientHeight/scrollTop，
                 * 在 touchmove 里等于每次滑动都强制同步布局，图标解码引起的样式失效会把它放大成明显掉帧。 */
                if (start === null) return;
                const y = event.touches[0].clientY;
                distance = Math.min(100, Math.max(0, (start - y) * 0.65));
                if (distance > 0 && event.cancelable) event.preventDefault();
                const phase = distance >= threshold ? 'armed' : distance > 0 ? 'pulling' : 'idle';
                setState(previous => previous.phase === phase ? previous : { phase, distance });
            };
            const end = () => { const ready = distance >= threshold; start = null; if (ready) load(); else if (!busy) reset(); };
            const cancel = () => { if (!busy) reset(); };
            const key = event => {
                if (event.target.closest('[data-app-pull]') && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault(); load();
                }
            };
            node.addEventListener('touchstart', begin, { passive: true });
            node.addEventListener('touchmove', move, { passive: false });
            node.addEventListener('touchend', end);
            node.addEventListener('touchcancel', cancel);
            node.addEventListener('keydown', key);
            reset();
            return () => {
                alive = false; clearTimeout(timer);
                node.removeEventListener('touchstart', begin); node.removeEventListener('touchmove', move);
                node.removeEventListener('touchend', end); node.removeEventListener('touchcancel', cancel);
                node.removeEventListener('keydown', key);
            };
        }, [options.resetKey]);
        return { ref, phase: state.phase, distance: state.distance };
    };
})(window.CP = window.CP || {});