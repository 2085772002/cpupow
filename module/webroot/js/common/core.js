/* 说明：core.js — 全局常量、工具函数、KsuService、NameResolver
 * 由 index.html 在 React 之后加载，向 window.CP 暴露共享设施。
 */
(function () {
    'use strict';
    var h = React.createElement;

    /* 说明：路径常量 */
    var MODULE_DIR = '/data/adb/modules/cpupow';
    var JSON_PATH = MODULE_DIR + '/etc/pkg_rules.json';
    var CONFIG_PATH = MODULE_DIR + '/cpu_policy.json';
    var MANUAL_MODE_PATH = MODULE_DIR + '/manual_mode.txt';

    /* 说明：KsuService：ksu.exec 的 Promise 封装 */
    var KsuService = {
        exec: function (cmd) {
            return new Promise(function (resolve) {
                if (window.ksu && window.ksu.exec) {
                    var cbName = 'ksu_cb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                    var timeout = setTimeout(function () {
                        delete window[cbName];
                        resolve({ errno: -1, stdout: '', stderr: 'Timeout' });
                    }, 15000);
                    window[cbName] = function (errno, stdout, stderr) {
                        clearTimeout(timeout);
                        delete window[cbName];
                        resolve({ errno: errno, stdout: stdout || '', stderr: stderr || '' });
                    };
                    try { window.ksu.exec(cmd, '{}', cbName); }
                    catch (e) { clearTimeout(timeout); delete window[cbName]; resolve({ errno: -1, stdout: '', stderr: 'Bridge unavailable' }); }
                } else {
                    /* 说明：生产桥接缺失时明确失败，不使用模拟数据冒充运行结果。 */
                    resolve({ errno: -1, stdout: '', stderr: 'Root bridge unavailable' });
                }
            });
        },
        toast: function (msg) {
            if (window.ksu && window.ksu.toast) window.ksu.toast(msg);
            else if (window.showToast) window.showToast(msg);
        },
        /* 说明：具体配置事务由 cpu_policy_service 接管；未装载服务时禁止退回旧的覆盖式写入。 */
        writeJson: function () { return Promise.resolve({ ok: false, msg: '配置事务服务尚未装载' }); }

    };

    /* 说明：状态和日志统一经基础设施读取，页面不拼接设备命令。 */
    KsuService.readRuntimeStatus = async function () {
        var result = await KsuService.exec('sh ' + MODULE_DIR + '/bin/status.sh');
        if (!result || result.errno !== 0) throw new Error('运行状态读取失败，请检查 Root 授权和模块文件');
        var value;
        try { value = JSON.parse(result.stdout); } catch (e) { throw new Error('运行状态数据不完整'); }
        if (!value || value.schema !== 1 || !value.daemon || !value.watchdog || !value.module ||
            !Number.isFinite(value.checked_uptime_s) || value.checked_uptime_s < 0 ||
            typeof value.daemon.running !== 'boolean' || typeof value.watchdog.running !== 'boolean' ||
            typeof value.module.disabled !== 'boolean' || typeof value.module.removing !== 'boolean' ||
            typeof value.boot_id !== 'string' || !value.boot_id ||
            (value.daemon.running && (!Number.isInteger(value.daemon.pid) || value.daemon.pid <= 0 || !Number.isInteger(value.daemon.start_ticks) || value.daemon.start_ticks <= 0))) {
            throw new Error('运行状态格式无效');
        }
        return value;
    };
    KsuService.readLogs = async function () {
        var file = MODULE_DIR + '/cpu_policy.log';
        var cmd = 'if [ -f ' + file + ' ]; then printf "CPLOG:present\\n"; tail -n 300 ' + file +
            '; elif [ -d ' + MODULE_DIR + ' ] && [ ! -e ' + file + ' ]; then printf "CPLOG:missing\\n"; else exit 1; fi';
        var result = await KsuService.exec(cmd);
        if (!result || result.errno !== 0) throw new Error('日志读取失败，请检查文件权限后重试');
        var text = String(result.stdout || ''), end = text.indexOf('\n');
        var tag = end < 0 ? text.trim() : text.slice(0, end).trim();
        if (tag !== 'CPLOG:present' && tag !== 'CPLOG:missing') throw new Error('日志返回格式无效');
        return { exists: tag === 'CPLOG:present', lines: tag === 'CPLOG:missing' ? [] : text.slice(end + 1).split('\n').filter(function (line) { return line.trim(); }) };
    };

    /* 说明：应用配置基础设施：串行写入，读等待正在提交的规则，切页不会读到旧值。 */
    var appRuleWrites = Promise.resolve();
    KsuService.listApplications = async function () {
        var results = await Promise.all([
            KsuService.exec('pm list packages -e -3 2>/dev/null'),
            KsuService.exec('pm list packages -e -s 2>/dev/null')
        ]);
        if (results.some(function (r) { return !r || r.errno !== 0; })) throw new Error('applications unavailable');
        var types = {};
        results.forEach(function (r, i) {
            String(r.stdout || '').split(/\r?\n/).forEach(function (line) {
                var match = /^package:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)$/.exec(line.trim());
                if (match) types[match[1]] = i === 0 ? 'user' : 'system';
            });
        });
        return Object.keys(types).map(function (pkg) { return { pkg: pkg, type: types[pkg] }; });
    };
    /* 说明：每次原生回调均受限；快照变化时整次重试，禁止拼接不同代数据，不写运行文件。 */
    var profileReads = Object.create(null), profileCache = Object.create(null);
    async function readProfileRaw(kind, job) {
        var path = MODULE_DIR + '/profile_battery.json';
        var read = async function (cmd) {
            if (job.cancelled || Date.now() > job.deadline) throw new Error('耗电数据读取已取消或超时');
            var r = await KsuService.exec(cmd);
            if (job.cancelled || Date.now() > job.deadline) throw new Error('耗电数据读取已取消或超时');
            if (!r || (r.errno !== undefined && r.errno !== 0)) throw new Error('耗电数据读取失败：' + ((r && r.stderr) || '文件不可用'));
            return String(r.stdout || r.output || '').trim();
        };
        var parse = function (text) {
            var p;
            try { p = JSON.parse(text); } catch (e) { throw new Error('耗电数据数据不完整或格式无效'); }
            if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('耗电数据格式无效');
            return p;
        };
        for (var attempt = 0; attempt < 2; attempt++) {
            var meta;
            try { meta = await read('wc -c < ' + path + ' 2>/dev/null; sha256sum ' + path + ' 2>/dev/null'); }
            catch (e) { throw e; }
            var match = /^(\d+)\s+([a-f0-9]{64})(?:\s|$)/.exec(meta);
            /* 说明：兼容未提供分块元信息的旧守护进程和测试桥接。 */
            if (!match) {
                
                var plain = await read('cat ' + path + ' 2>/dev/null');
                
                return parse(plain);
            }
            var bytes = Number(match[1]), before = match[2];
            if (!(bytes > 0) || bytes > 16 * 1024 * 1024) throw new Error('耗电数据大小异常');
            if (bytes <= 49152) return parse(await read('cat ' + path + ' 2>/dev/null'));
            var chunks = [], chunkSize = 24576;
            for (var offset = 0; offset < bytes; offset += chunkSize) {
                /* 说明：v2.5.4：每块之间让出一次宏任务。
                 * ksu.exec 是同步桥接，而 await 只排微任务——整份历史读下来，
                 * 几十个 dd|base64|tr 会连成一个长任务，期间页面完全不绘制。
                 * 让出一帧后同样的读取总时长不变，但界面能持续响应。 */
                if (offset) await new Promise(function (done) { setTimeout(done, 0); });
                var text = await read('dd if=' + path + ' bs=' + chunkSize + ' skip=' + (offset / chunkSize) + ' count=1 2>/dev/null | base64 | tr -d "\\r\\n"');
                var binary;
                try { binary = atob(text); } catch (e) { throw new Error('耗电数据分块传输失败'); }
                var expected = Math.min(chunkSize, bytes - offset);
                if (binary.length !== expected) throw new Error('耗电数据分块长度不完整');
                chunks.push(binary);
            }
            var after = await read('sha256sum ' + path + ' 2>/dev/null');
            if (after.split(/\s/)[0] !== before) continue;
            var raw = chunks.join(''), decoded;
            try {
                if (typeof TextDecoder !== 'undefined') {
                    var data = new Uint8Array(raw.length);
                    for (var i = 0; i < raw.length; i++) {
                        data[i] = raw.charCodeAt(i);
                        if (i && i % 65536 === 0) { await new Promise(function (done) { setTimeout(done, 0); }); if (job.cancelled) throw new Error('cancelled'); }
                    }
                    decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
                } else decoded = decodeURIComponent(Array.prototype.map.call(raw, function (c) { return '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
            } catch (e) { throw new Error('耗电数据编码无效'); }
            return parse(decoded);
        }
        throw new Error('耗电数据更新较快，本次未取得一致快照；可重新刷新');
    }
    /* 说明：同一模型共用一次传输，各组件独立订阅；最后一个订阅者退出即取消后续分块，切页不遗留原生命令队列。 */
    KsuService.readProfile = function (kind, options) {
        options = options || {}; var key = 'battery';
        var signal = options.signal, cached = profileCache[key];
        if (signal && signal.aborted) return Promise.reject(new Error('耗电数据读取已取消'));
        if (options.cache === true && !options.force && cached && Date.now() - cached.at < 5000) return Promise.resolve(cached.value);
        var job = profileReads[key];
        if (!job || job.cancelled) {
            job = { users: 0, cancelled: false, deadline: Date.now() + 20000 };
            profileReads[key] = job;
            (function (owned) {
                owned.promise = readProfileRaw(kind, owned).then(function (value) {
                    if (!owned.cancelled) profileCache[key] = { at: Date.now(), value: value };
                    return value;
                }).finally(function () { if (profileReads[key] === owned) delete profileReads[key]; });
            })(job);
        }
        job.users++;
        return new Promise(function (resolve, reject) {
            var settled = false, timer;
            function finish(error, value) {
                if (settled) return; settled = true; clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', cancel);
                if (--job.users === 0 && error) job.cancelled = true;
                if (error) reject(error); else resolve(value);
            }
            function cancel() { finish(new Error('耗电数据读取已取消')); }
            if (signal) signal.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(function () { finish(new Error('耗电数据读取超时，请刷新重试')); }, 20000);
            job.promise.then(function (value) { finish(null, value); }, function (error) { finish(error); });
        });
    };
    KsuService.readAppRules = async function () {
        await appRuleWrites;
        var r = await KsuService.exec('cat ' + JSON_PATH + ' 2>/dev/null');
        if (!r || r.errno !== 0 || !String(r.stdout || '').trim()) throw new Error('rules unavailable');
        return JSON.parse(r.stdout);
    };
    KsuService.writeAppRules = function (rules) {
        /* 说明：在入队时冻结快照，不受调用方后续修改影响。临时文件与目标同目录，mv 为原子替换。 */
        var json;
        try { json = JSON.stringify(rules); } catch (e) { return Promise.resolve({ ok: false }); }
        var run = async function () {
            var tmp = JSON_PATH + '.tmp.' + Date.now() + '_' + Math.random().toString(36).slice(2);
            var quote = function (text) { return "'" + text.replace(/'/g, "'\\''") + "'"; };
            try {
                var r = await KsuService.exec("umask 022; printf '%s' " + quote(json) + ' > ' + tmp + ' && cat ' + tmp);
                if (!r || r.errno !== 0 || JSON.stringify(JSON.parse(r.stdout)) !== json) return { ok: false };
                var moved = await KsuService.exec('mv -f ' + tmp + ' ' + JSON_PATH);
                return { ok: !!moved && moved.errno === 0 };
            } catch (e) {
                return { ok: false };
            } finally {
                try { await KsuService.exec('rm -f ' + tmp); } catch (e) {}
            }
        };
        var task = appRuleWrites.then(run, run);
        appRuleWrites = task.catch(function () {});
        return task;
    };

    /* 说明：NameResolver：应用名解析（三级降级 + 缓存） */
    var NameResolver = {
        /* 说明：名字缓存持久化到 localStorage：重进页面首帧即真名，不再 fallback→真名 闪烁 */
        cache: (function () {
            try {
                var c = JSON.parse(localStorage.getItem('cpupow_names') || '{}');
                return (c && typeof c === 'object') ? c : {};
            } catch (e) { return {}; }
        })(),
        persist: function () {
            /* 说明：1 秒节流合并：几百包连续解析时避免每次全量序列化同步写卡主线程 */
            if (this._pt) return;
            var self = this;
            this._pt = setTimeout(function () {
                self._pt = null;
                try { localStorage.setItem('cpupow_names', JSON.stringify(self.cache)); } catch (e) {}
            }, 1000);
        },
        formatFallback: function (pkg) {
            var parts = pkg.split('.').filter(function (p) { return ['com', 'cn', 'net', 'org', 'io', 'cc', 'android'].indexOf(p) < 0; });
            var out = parts.map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
            return out || pkg;
        },
        resolve: function (pkg) {
            var self = this;
            return (async function () {
                if (self.cache[pkg]) return self.cache[pkg];
                var name = self.formatFallback(pkg);
                try {
                    if (window.ksu && window.ksu.getPackagesInfo) {
                        var res = JSON.parse(window.ksu.getPackagesInfo(JSON.stringify([pkg])));
                        if (res && res[0] && res[0].appLabel) { self.cache[pkg] = res[0].appLabel; self.persist(); return res[0].appLabel; }
                    }
                } catch (e) {}
                if (window.$packageManager) {
                    try {
                        var label = window.$packageManager.getApplicationInfo(pkg, 0, 0).getLabel();
                        if (label) { self.cache[pkg] = label; self.persist(); return label; }
                    } catch (e) {}
                }
                try {
                    var r = await KsuService.exec('timeout 10 sh -c "dumpsys package ' + pkg + ' 2>/dev/null | grep -m1 \\"application-info\\" | sed \\"s/.*label=\\([^ }]*\\).*/\\1/\\""');
                    var lbl = (r.stdout || '').trim();
                    if (lbl && lbl !== 'null' && lbl.length > 1) { self.cache[pkg] = lbl; self.persist(); return lbl; }
                } catch (e) {}
                self.cache[pkg] = name;
                return name;
            })();
        }
    };

    /* 说明：跨页队列合并相同包名，原生标签读取之间让出线程；原生接口在异步函数中仍为同步调用。 */
    (function () {
        var original = NameResolver.resolve, queue = [], running = false, pending = Object.create(null);
        function pump() {
            if (running || !queue.length) return;
            running = true;
            var item = queue.shift();
            afterPaint(function () {
                Promise.resolve().then(function () {
                    return item.cancelled ? NameResolver.formatFallback(item.pkg) : original.call(NameResolver, item.pkg);
                }).then(item.resolve, item.reject).finally(function () {
                    if (pending[item.pkg] === item) delete pending[item.pkg];
                    running = false; pump();
                });
            });
        }
        NameResolver.resolve = function (pkg, options) {
            var self = this, signal = options && options.signal;
            if (self.cache[pkg]) return Promise.resolve(self.cache[pkg]);
            if ((signal && signal.aborted) || queue.length >= 1024 || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(pkg)) return Promise.resolve(self.formatFallback(pkg));
            var job = pending[pkg];
            if (!job || job.cancelled) {
                job = { pkg: pkg, users: 0, cancelled: false };
                job.promise = new Promise(function (resolve, reject) { job.resolve = resolve; job.reject = reject; });
                pending[pkg] = job; queue.push(job);
            }
            job.users++;
            var result = new Promise(function (resolve, reject) {
                var done = false;
                function finish(error, value) {
                    if (done) return; done = true;
                    if (signal) signal.removeEventListener('abort', cancel);
                    if (--job.users === 0 && signal && signal.aborted) {
                        job.cancelled = true;
                        var index = queue.indexOf(job);
                        if (index >= 0) { queue.splice(index, 1); job.resolve(self.formatFallback(pkg)); }
                        if (pending[pkg] === job) delete pending[pkg];
                    }
                    if (error) reject(error); else resolve(value);
                }
                function cancel() { finish(null, self.formatFallback(pkg)); }
                if (signal) signal.addEventListener('abort', cancel, { once: true });
                job.promise.then(function (value) { finish(null, value); }, function (error) { finish(error); });
            });
            pump(); return result;
        };
    })();

    /* 说明：冷启动共用有界调度队列；组件与预热共用并发上限，避免同时解码大量图标。 */
    var IconExtractor = {
        dir: MODULE_DIR + '/webroot/icons/', dex: MODULE_DIR + '/webroot/tool/classes.dex',
        attempted: {}, known: (function () {
            try { var a=JSON.parse(localStorage.getItem('cpupow_icons')||'[]'),m={};
                if(Array.isArray(a))a.slice(0,4096).forEach(function(p){if(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(p))m[p]=1;});
                return m; } catch(e){return {};}
        })(),
        failed: {}, _ready: {}, _decoding: {}, _pool: {}, _order: [],
        _queue: [], _active: 0, _extractQueue: [], _extractPending: {}, _extractBusy: false,
        _listeners: [], _persistT: null, _probeP: null, _probeFlight: null,
        decodeLimit: 8, decodeTimeout: 4000, queueLimit: 1024, poolLimit: 256,
        _valid: function(p){return typeof p==='string' && p.length<256 && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(p);},
        subscribe: function(fn){var self=this;self._listeners.push(fn);return function(){self._listeners=self._listeners.filter(function(f){return f!==fn;});};},
        /* 说明：图标解码完成的通知合并成批。原来每解码一个就广播一次，
         * 首屏 40 个图标会在几百毫秒内触发几十轮 setState，与滚动帧抢主线程；
         * 这里 120ms 汇总一次，把重渲染次数从 O(图标数) 降到 O(时间窗)。 */
        _notify: function(pkg){
            var self=this;
            self._pending=self._pending||{};
            self._pending[pkg]=1;
            if(self._notifyT)return;
            self._notifyT=setTimeout(function(){
                self._notifyT=null;
                var list=Object.keys(self._pending);self._pending={};
                var fns=self._listeners.slice();
                for(var i=0;i<fns.length;i++)for(var j=0;j<list.length;j++){try{fns[i](list[j]);}catch(e){}}
            },120);
        },
        _persist: function(){if(this._persistT)return;var self=this;this._persistT=setTimeout(function(){self._persistT=null;try{localStorage.setItem('cpupow_icons',JSON.stringify(Object.keys(self.known).slice(0,4096)));}catch(e){}},1000);},
        setKnown: function(map){this.known=map||{};this._persist();},
        hasIcon: function(pkg){return !!this.known[pkg] && !this.hasFailed(pkg);},
        hasFailed: function(pkg){if(this.failed[pkg] && Date.now()-this.failed[pkg]>=300000)delete this.failed[pkg];return !!this.failed[pkg];},
        /* 说明：解码失败必须同时清掉 known 与 attempted。
         * known 是 localStorage 持久化的白名单，若图标文件被删（用户清理、重装）
         * 而 known 还留着记录，ensure() 会认为「已有图标」直接跳过提取，
         * 于是这些包永久显示不出图标——正是「删掉图标后有些加载不出来」的原因。 */
        /* 说明：decode 失败——白名单说文件在，但实际读不出（文件被删/损坏）。
         * 必须清 known 与 attempted，让下一轮 ensure 重新提取。 */
        markFailed: function(pkg){
            if(!pkg)return;
            this.failed[pkg]=Date.now();
            delete this._ready[pkg];delete this._pool[pkg];
            delete this.known[pkg];delete this.attempted[pkg];
            this._persist();
        },
        /* 说明：提取失败——IconTool 明确表示该包没有可用图标。
         * 保留 attempted，5 分钟内不再重试，避免整轮队列被同一个包反复占用。 */
        markExtractFailed: function(pkg){
            if(!pkg)return;
            this.failed[pkg]=Date.now();
            delete this._ready[pkg];delete this._pool[pkg];
            delete this.known[pkg];
        },
        isReady: function(pkg){return !!this._ready[pkg];},
        /* 说明：该包是否仍在提取队列中（供 AppIcon 判断「还在排队」而不是「已经失败」）。 */
        pending: function(pkg){return !!(pkg && this._extractPending[pkg]);},
        _pump: function(){
            var self=this;
            while(self._active<self.decodeLimit && self._queue.length){
                (function(job){
                    self._active++;var im=new Image(),done=false;
                    var finish=function(okv){
                        if(done)return;done=true;clearTimeout(timer);im.onload=im.onerror=null;
                        self._active--;delete self._decoding[job.pkg];
                        if(okv){
                            delete self.failed[job.pkg];self._pool[job.pkg]=im;self._ready[job.pkg]=1;
                            self._order=self._order.filter(function(p){return p!==job.pkg;});self._order.push(job.pkg);
                            while(self._order.length>self.poolLimit){var old=self._order.shift();delete self._pool[old];delete self._ready[old];}
                        }else{self.markFailed(job.pkg);im.src='';}
                        job.resolve(!!okv);self._notify(job.pkg);
                        /* 说明：原来每次完成都等 16ms 再拉下一个，31 个图标要空转 0.5 秒。
                         * 改微任务调度：既不空转，也避免同步递归过深。 */
                        Promise.resolve().then(function(){self._pump();});
                    };
                    var timer=setTimeout(function(){
                        if (CP.diagLog) CP.diagLog('icon_decode_timeout', job.pkg);
                        finish(false);
                    },self.decodeTimeout);
                    im.onload=function(){
                        if(typeof im.decode==='function')im.decode().then(function(){finish(true);},function(){finish(false);});
                        else finish(true);
                    };
                    im.onerror=function(){
                        if (CP.diagLog) CP.diagLog('icon_decode_fail', job.pkg);
                        finish(false);
                    };
                    im.src='icons/'+encodeURIComponent(job.pkg)+'.png';
                })(self._queue.shift());
            }
        },
        decode: function(pkg){
            var self=this;
            if(!self._valid(pkg))return Promise.resolve(false);
            if(self._ready[pkg])return Promise.resolve(true);
            if(self._decoding[pkg])return self._decoding[pkg];
            if(self.hasFailed(pkg) || self._queue.length>=self.queueLimit)return Promise.resolve(false);
            var resolve,p=new Promise(function(r){resolve=r;});
            self._decoding[pkg]=p;self._queue.push({pkg:pkg,resolve:resolve});self._pump();return p;
        },
        prime: function(pkgs,onlyKnown){
            var self=this,seen={},list=(pkgs||[]).filter(function(p){if(!self._valid(p)||seen[p]||self.hasFailed(p)|| (onlyKnown&&!self.known[p]))return false;seen[p]=1;return !self._ready[p];}).slice(0,self.queueLimit);
            return Promise.all(list.map(function(p){return self.decode(p);})).then(function(r){return r.length;});
        },
        probe: function(){
            var self=this;if(self._probeFlight)return self._probeFlight;
            self._probeFlight=KsuService.exec('ls -1 "'+self.dir+'" 2>/dev/null').then(function(r){
                if(r.errno!==0)return self.known;var have={};
                String(r.stdout||'').trim().split(/\s+/).forEach(function(l){if(l.slice(-4)==='.png' && self._valid(l.slice(0,-4)))have[l.slice(0,-4)]=1;});
                self.setKnown(have);return have;
            }).catch(function(){return self.known;}).then(function(have){self._probeFlight=null;return have;});return self._probeFlight;
        },
        probeOnce: function(){if(!this._probeP)this._probeP=this.probe();return this._probeP;},
        /* 说明：每次桥接启动单个虚拟机，最多提取四个图标；跳过有效缓存、限制尺寸、原子发布，超时限制包管理器和资源查询。 */
        _extractPump: function(){
            var self=this;if(self._extractBusy)return;
            self._extractQueue=self._extractQueue.filter(function(job){if(job.cancelled){delete self._extractPending[job.pkg];delete self.attempted[job.pkg];job.resolve(false);return false;}return true;});
            if(!self._extractQueue.length)return;
            var jobs=self._extractQueue.splice(0,4);jobs.forEach(function(job){job.started=true;});self._extractBusy=true;
            var args=jobs.map(function(j){return j.pkg;}).join(' ');
            var cmd='if command -v timeout >/dev/null 2>&1; then CLASSPATH='+self.dex+' timeout -k 1 8 app_process64 /system/bin IconTool --batch '+self.dir+' '+args+'; else exit 127; fi';
            KsuService.exec(cmd).then(function(r){
                var made={};String(r.stdout||'').split(/\r?\n/).forEach(function(l){var m=/^OK ([A-Za-z0-9_.]+) [0-9]+$/.exec(l.trim());if(m)made[m[1]]=1;});
                var okCount=0;
                jobs.forEach(function(j){
                    var okv=!!made[j.pkg];
                    if(okv){okCount++;self.known[j.pkg]=1;delete self.failed[j.pkg];}
                    /* 说明：没返回 OK 只代表「这一轮没提取出来」——可能是超时、IconTool 被系统限制、
                     * 或该包确实无图标。这里刻意不设 failed、不清 known：
                     * 设了 failed 会让 AppIcon 立刻退回首字母且 5 分钟内不再尝试，
                     * 一次批量超时就会让整屏图标全部「废掉」。留给下一轮 ensure 自然重试。 */
                    delete self._extractPending[j.pkg];
                    delete self.attempted[j.pkg];
                    self._notify(j.pkg);
                    j.resolve(okv);
                });self._persist();
                /* 说明：记录每批结果。全部失败通常意味着 IconTool 本身跑不起来
                 * （dex 缺失 / app_process64 受限），而不是这些包没有图标。 */
                if (CP.diagLog) {
                    /* 说明：带上包名（尾段），才能确认某个具体应用到底有没有被提交、有没有成功。 */
                    var names = jobs.map(function (j) {
                        var p = j.pkg; return (made[p] ? '+' : '-') + (p.length > 22 ? p.slice(-22) : p);
                    }).join(' ');
                    CP.diagLog('icon_batch', 'ok=' + okCount + '/' + jobs.length +
                        ' queue=' + self._extractQueue.length + ' errno=' + (r && r.errno) + ' [' + names + ']');
                }
            }).catch(function(){jobs.forEach(function(j){delete self._extractPending[j.pkg];j.resolve(false);});}).then(function(){self._extractBusy=false;setTimeout(function(){self._extractPump();},100);});
        },
        ensure: function(pkgs,options){
            var self=this,now=Date.now(),seen={},signal=options&&options.signal;
            if(signal&&signal.aborted)return Promise.resolve([]);
            var list=(pkgs||[]).filter(function(p){if(!self._valid(p)||seen[p])return false;seen[p]=1;return true;}).slice(0,self.queueLimit);
            var work=list.map(function(p){
                if(self._extractPending[p])return self._extractPending[p];
                if(self.known[p]&&!self.hasFailed(p))return Promise.resolve(true);
                if(self.attempted[p] && now-self.attempted[p]<300000)return Promise.resolve(false);
                if(self._extractQueue.length>=self.queueLimit)return Promise.resolve(false);
                var resolve,promise=new Promise(function(r){resolve=r;});self.attempted[p]=now;
                var job={pkg:p,resolve:resolve,cancelled:false};
                var cancel=function(){
                    if(job.started)return;
                    job.cancelled=true;var index=self._extractQueue.indexOf(job);
                    if(index>=0)self._extractQueue.splice(index,1);
                    if(self._extractPending[p]===promise){delete self._extractPending[p];delete self.attempted[p];}
                    resolve(false);
                };
                if(signal)signal.addEventListener('abort',cancel,{once:true});
                promise.finally(function(){if(signal)signal.removeEventListener('abort',cancel);});
                self._extractPending[p]=promise;self._extractQueue.push(job);return promise;
            });self._extractPump();return Promise.all(work);
        },
        launch: function(pkgs,options){return this.ensure(pkgs,options).then(function(r){return r.some(Boolean);});}
    };


    /* 说明：通用小工具 */
    var getInitials = function (pkg) {
        var parts = pkg.split('.').filter(function (p) { return p !== 'com' && p !== 'cn' && p !== 'net'; });
        return (parts[0] ? parts[0].charAt(0).toUpperCase() : '?') + (parts[1] ? parts[1].charAt(0).toUpperCase() : (parts[0] ? parts[0].charAt(1).toUpperCase() : ''));
    };
    var getPkgColor = function (pkg) {
        var colors = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-500', 'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500', 'bg-pink-500', 'bg-rose-500'];
        var hash = 0;
        for (var i = 0; i < pkg.length; i++) hash = pkg.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    };
    var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
    var fmtFreq = function (hz) {
        if (!hz) return '--';
        var n = Number(hz);
        if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + ' GHz';
        return (n / 1000).toFixed(0) + ' MHz';
    };

    /* 说明：页面保活只保存视图，非当前页和后台文档不允许启动读取、轮询与图标任务。 */
    var scopes = [];
    function createPageScope(selected) {
        var listeners = new Set(), loadListeners = new Set(), loads = new Map(), reported = false;
        /* 说明：firstLoadDone 记录本页是否已完成过首次数据加载。
         * 之后再次切回时不再盖全屏遮罩，只保留顶部细进度条，避免"切换要等 sh 跑完"的卡顿观感。 */
        var firstLoadDone = false;
        function anyBusy() { return Array.from(loads.values()).some(Boolean); }
        function notifyLoading() { loadListeners.forEach(function (listener) { listener(); }); }
        var scope = {
            selected: selected,
            warming: false,
            subscribeLoading: function (listener) { loadListeners.add(listener); return function () { loadListeners.delete(listener); }; },
            isLoading: function () { return !reported || anyBusy(); },
            isFirstLoading: function () { return !firstLoadDone; },
            reportLoading: function (key, busy) {
                var before = scope.isLoading();
                reported = true; loads.set(key, !!busy);
                if (!anyBusy()) firstLoadDone = true;
                if (before !== scope.isLoading()) notifyLoading();
            },
            removeLoading: function (key) { var before = scope.isLoading(); loads.delete(key); if (before !== scope.isLoading()) notifyLoading(); },
            /* 说明：warming 用于启动后的预加载——组件已挂载、数据先读好，但不参与可见性判断。
             * 用户真正进入时由 setActive 接管，两者互不覆盖。 */
            isActive: function () { return (scope.selected || scope.warming) && !document.hidden; },
            subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
            notify: function () { listeners.forEach(function (listener) { listener(); }); },
            setActive: function (next) { if (scope.selected !== next) { scope.selected = next; scope.notify(); } },
            setWarm: function (next) { if (scope.warming !== next) { scope.warming = !!next; scope.notify(); } },
            dispose: function () { scope.setActive(false); var index = scopes.indexOf(scope); if (index >= 0) scopes.splice(index, 1); listeners.clear(); loads.clear(); loadListeners.clear(); }
        };
        scopes.push(scope); return scope;
    }
    document.addEventListener('visibilitychange', function () { scopes.forEach(function (scope) { scope.notify(); }); });
    var PageActiveContext = React.createContext(createPageScope(true));
    function usePageScope() { return React.useContext(PageActiveContext); }
    /* 说明：这里刻意不用 useSyncExternalStore。
     * React 18 只要树里存在 useSyncExternalStore，就会把更新当作同步处理并放弃并发渲染，
     * startTransition 的可打断能力随之失效——表现为切页时整棵树同步渲染、主线程被占满。
     * 改用普通 useState + 订阅，让 React 回到并发模式。 */
    function usePageActive() {
        var scope = usePageScope();
        var state = React.useState(function () { return scope.isActive(); });
        React.useEffect(function () {
            return scope.subscribe(function () { state[1](scope.isActive()); });
        }, [scope]);
        return state[0];
    }
    /* 说明：统一报告首载忙状态；只订阅轻量页面壳，后台轮询不强制遮挡已有内容。 */
    function usePageLoading(busy) {
        var scope = usePageScope(), key = React.useRef({});
        React.useLayoutEffect(function () { scope.reportLoading(key.current, busy); }, [scope, busy]);
        React.useEffect(function () { return function () { scope.removeLoading(key.current); }; }, [scope]);
    }
    /* 说明：订阅生命周期仅清理和调度副作用。切换页面立即开始读取，不再等两帧，
     * 读取本身是异步的，不阻塞路由壳绘制。 */
    /* 说明：页面任务一律推迟到浏览器完成一次绘制之后再执行。
     *
     * 原因：KernelSU 的 window.ksu.exec 是 JavaScriptInterface 同步调用——它会把
     * sh 命令跑完才返回，期间 JS 主线程被占住，浏览器无法绘制。若在 effect 里
     * 直接调用，点击悬浮栏后的高亮变字和页面壳都要等 sh 跑完才上屏，
     * 表现为「点击背景出来了、文字变色和图标要等加载完」。
     *
     * 这里用「下一帧 + 宏任务」把任务推到绘制之后：先让高亮与加载壳上屏，
     * 再执行会阻塞的 sh 调用。用户看到的是即时响应 + 转圈，而不是整体卡住。
     */
    function usePageTask(effect, dependencies) {
        var scope = usePageScope();
        React.useEffect(function () {
            var cleanup = null, cancel = null, guard = null;
            function stop() {
                if (cancel) { cancel(); cancel = null; }
                if (guard) { clearTimeout(guard); guard = null; }
                if (cleanup) { cleanup(); cleanup = null; }
            }
            function schedule() {
                stop();
                if (!scope.isActive()) return;
                cancel = afterPaint(function () {
                    cancel = null;
                    if (!scope.isActive()) return;
                    /* 说明：绘制之后再留 120ms 窗口。快速连点时页面往往在这个窗口内就切走了，
                     * 于是完全不会触发 sh——这是「点一下就切过、卡在最后一页」的根治点。 */
                    guard = setTimeout(function () {
                        guard = null;
                        if (!scope.isActive()) return;
                        cleanup = effect() || null;
                    }, 120);
                });
            }
            var unsubscribe = scope.subscribe(schedule);
            schedule();
            return function () { unsubscribe(); stop(); };
        }, [scope].concat(dependencies));
    }
    /* 说明：两次帧回调之间至少留出一次绘制机会；快速改选会取消尚未执行的挂载或任务。 */
    function afterPaint(callback) {
        var stopped = false, timer = null, second = null;
        var frame = requestAnimationFrame(function () {
            second = requestAnimationFrame(function () {
                timer = setTimeout(function () { if (!stopped) callback(); }, 0);
            });
        });
        return function () { stopped = true; cancelAnimationFrame(frame); if (second !== null) cancelAnimationFrame(second); clearTimeout(timer); };
    }

    /* 说明：前端诊断日志。记录关键交互路径，供「切页无效」这类只在真机复现的问题定位。
     * 只在内存里追加（零成本），由用户手动导出成文件，不写磁盘、不占主线程。 */
    var diagBuf = [], DIAG_MAX = 400;
    function diagLog(tag, data) {
        var entry = Date.now() + ' ' + tag;
        if (data !== undefined && data !== null) {
            var text;
            try { text = typeof data === 'string' ? data : JSON.stringify(data); }
            catch (e) { text = String(data); }
            entry += ' ' + text;
        }
        diagBuf.push(entry);
        if (diagBuf.length > DIAG_MAX) diagBuf.shift();
    }
    /* 说明：导出当前页面上每个 AppIcon 的真实状态。
     * 提取成功（icon_batch ok=4/4）不等于图标能显示——还要 known→needDecode→decode→ready 四步。
     * 这份快照能直接指出某个包卡在哪一步。 */
    function diagIcons() {
        var IE = CP.IconExtractor;
        if (!IE) return '(IconExtractor 未加载)';
        var nodes = document.querySelectorAll('[data-app-icon]');
        var lines = ['', '=== 解码队列 ===',
            '  待解码 queue=' + (IE._queue ? IE._queue.length : '?') +
            '  进行中 active=' + (IE._active || 0) +
            '  并发上限 decodeLimit=' + (IE.decodeLimit || '?') +
            '  已就绪 ready=' + Object.keys(IE._ready || {}).length +
            '  已失败 failed=' + Object.keys(IE.failed || {}).length,
            '', '=== AppIcon 状态（页面共 ' + nodes.length + ' 个）==='];
        var seen = {}, stat = { ready: 0, pending: 0, known: 0, missing: 0, failed: 0 };
        for (var i = 0; i < nodes.length; i++) {
            var pkg = nodes[i].getAttribute('data-app-icon');
            if (!pkg || seen[pkg]) continue;
            seen[pkg] = 1;
            var known = !!(IE.known && IE.known[pkg]);
            var ready = IE.isReady ? IE.isReady(pkg) : false;
            var failed = IE.isFailed ? IE.isFailed(pkg) : (IE.hasFailed ? IE.hasFailed(pkg) : false);
            var pend = IE.pending ? IE.pending(pkg) : false;
            var state;
            if (ready) { state = 'ready'; stat.ready++; }
            else if (pend) { state = 'pending(提取中)'; stat.pending++; }
            else if (failed) { state = 'failed'; stat.failed++; }
            else if (known) { state = 'known(有文件待解码)'; stat.known++; }
            else { state = 'missing(无文件)'; stat.missing++; }
            lines.push('  ' + pkg + ' => ' + state);
        }
        lines.unshift('汇总: ready=' + stat.ready + ' 提取中=' + stat.pending +
                      ' 有文件待解码=' + stat.known + ' 无文件=' + stat.missing + ' 失败=' + stat.failed);
        return lines.join('\n');
    }

    function diagText() {
        return '=== cpupow 前端诊断 ===\n' + '导出时间: ' + new Date().toISOString() + '\n' +
            'UA: ' + (navigator && navigator.userAgent ? navigator.userAgent : '?') + '\n' +
            '视口: ' + (window.innerWidth || 0) + 'x' + (window.innerHeight || 0) + '\n' +
            '滚动中: ' + (window.__cpScrolling ? 'yes' : 'no') + '\n' +
            diagIcons() + '\n\n--- 事件日志 ---\n' + diagBuf.join('\n');
    }
    function diagClear() { diagBuf.length = 0; }

    /* 说明：全局滚动状态。惯性滚动期间浏览器会推迟部分主线程工作，
     * 记录它才能判断「切页无效」是不是发生在滚动窗口内。 */
    (function () {
        var timer = null;
        function mark() {
            window.__cpScrolling = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { window.__cpScrolling = false; }, 200);
        }
        window.addEventListener('scroll', mark, { passive: true, capture: true });
        window.addEventListener('touchmove', mark, { passive: true, capture: true });
    })();

    window.CP = {
        h: h,
        diagLog: diagLog,
        diagText: diagText,
        diagClear: diagClear,
        PageActiveContext: PageActiveContext,
        createPageScope: createPageScope,
        usePageScope: usePageScope,
        usePageTask: usePageTask,
        usePageActive: usePageActive,
        usePageLoading: usePageLoading,
        afterPaint: afterPaint,
        MODULE_DIR: MODULE_DIR,
        JSON_PATH: JSON_PATH,
        CONFIG_PATH: CONFIG_PATH,
        MANUAL_MODE_PATH: MANUAL_MODE_PATH,
        KsuService: KsuService,
        NameResolver: NameResolver,
        IconExtractor: IconExtractor,
        getInitials: getInitials,
        getPkgColor: getPkgColor,
        clamp: clamp,
        fmtFreq: fmtFreq
    };
})();