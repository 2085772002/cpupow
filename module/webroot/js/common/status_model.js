/* 说明：运行健康纯模型；进程存活、心跳及硬件策略回执分别判断，不相互替代。 */
(function (CP) {
    'use strict';
    CP.RuntimeHealth = {
        summarize(value) {
            const fail = (label, detail, tone) => ({ label, detail, tone: tone || 'error' });
            if (!value || !value.module || !value.daemon || !value.watchdog || !Number.isFinite(value.checked_uptime_s)) return fail('状态未知', '尚未取得设备运行状态', 'unknown');
            const runtime = value.runtime;
            if (value.module.removing) return fail('模块待移除', '重启后模块将被移除', 'warning');
            if (value.module.disabled) return fail('模块已停用', '模块存在停用标记', 'warning');
            if (!value.daemon.running) return fail('程序未运行', '未确认到属于当前模块的守护进程');
            if (!runtime || runtime.schema !== 1 || runtime.pid !== value.daemon.pid ||
                runtime.boot_id !== value.boot_id || runtime.start_ticks !== value.daemon.start_ticks || !Number.isFinite(runtime.uptime_s)) {
                return fail('运行待确认', '进程存活，但未取得本次实例的心跳', 'warning');
            }
            if (runtime.stopping) return fail('程序退出中', '守护进程正在保存数据并释放资源', 'warning');
            const age = value.checked_uptime_s - runtime.uptime_s;
            if (age < -2 || age > 15) return fail('运行可能异常', '主循环心跳未及时更新', 'warning');
            if (runtime.config_valid !== true) return fail('策略配置无效', '进程存活，但已停止后续策略写入');
            if (!Number.isFinite(runtime.battery_uptime_s) || runtime.battery_uptime_s <= 0) {
                return fail('采样启动中', '主循环正常，等待首次耗电采样', 'warning');
            }
            if (runtime.battery_uptime_s - value.checked_uptime_s > 2 || value.checked_uptime_s - runtime.battery_uptime_s > 30) {
                return fail('耗电采样延迟', '主循环正常，但采样线程没有及时完成采样', 'warning');
            }
            if (!value.watchdog.running) return fail('守护监控未运行', '调度程序正常，自动拉起监控不可用', 'warning');
            return { label: '程序运行正常', detail: '进程身份、主循环心跳、耗电采样和守护监控均已确认', tone: 'ok' };
        },
        policy(value) {
            const policy = value && value.policy;
            if (!policy || !policy.base) return '暂无策略写入回执';
            const row = policy.touch && policy.touch.revision === policy.base.revision && policy.touch.mode === policy.base.mode && policy.touch.at_s >= policy.base.at_s ? policy.touch : policy.base;
            const names = {'*':'常规基础',touch_down:'短时间触摸',touch_long:'长时间触摸',touch_up:'松手过渡',touch_idle:'无触摸恢复'};
            /* 说明：v2.5.6 起写入做了去重：skipped 是「值没变、根本没碰 sysfs」的节点数。
             * 单独报出来，否则看到写入数骤降会以为策略没下发。 */
            return (names[row.phase] ? names[row.phase] + ' · ' : '') + '最近回执：写入 ' + (row.written || 0) + '，读回一致 ' + (row.readback_matched || 0) +
                '，不一致 ' + (row.readback_different || 0) + '，缺失 ' + (row.missing || 0) +
                '，拒绝 ' + (row.rejected || 0) + '，不可读 ' + (row.readback_unreadable || 0) +
                '，跳过重复 ' + (row.skipped || 0);
        }
    };
})(window.CP = window.CP || {});