/* 说明：CPU 配置领域模型，集中维护参数解释、分段校验和增量合并；禁止设备读写。 */
(function (CP) {
    'use strict';
    var specs = [
        ['pl','预测负载','bool','提前参考预测需求，突发任务更容易及时提频，也可能增加耗电。关闭不代表停止正常调频。'],
        ['target_loads','分段需求加减成','target','按需求区间放大或缩小：0 不变、10 加 10%、-10 减 10%。本内核共享核组可能重复缩放，宜小步调整。频率是需求分段标记，不是当前频率触发点。'],
        ['zone_max_util_pct','分区目标负载','zone','目标百分比越小越积极，越大越保守；80 对应约 1.25 倍基础映射，100 约 1 倍。它与分段加减成会叠加，边界含义不同。'],
        ['up_rate_limit_us','升频最短间隔','time','两次频率更新之间的升频等待限制，单位微秒。越小越及时，越大越克制；0 不增加这项等待。'],
        ['down_rate_limit_us','降频最短间隔','time','降频方向的最短更新间隔，单位微秒。越大越容易维持高频；不是保证高频驻留的固定倒计时。'],
        ['hispeed_load','高负载触发比例','percent','窗口结算时，未额外增强的负载相对上一窗口平均算力达到此比例，才可能触发高速档；还受频率条件等限制。内核把大于 100 的值压到 100，101 不是可靠的关闭开关。'],
        ['hispeed_freq','高负载目标频率','freq','满足高负载条件后，把请求至少抬到这里。0 只取消这一频率下限；高负载分支仍可能因新任务直接请求满需求，不能单独当作关闭开关。'],
        ['hispeed_cond_freq','高速档启用条件','freq','上一窗口平均算力对应频率低于这里时，不触发高速档及其新任务满需求分支。完整默认使用2147483647关闭本源码这条支路；这是条件哨兵，不是实际运行频率。'],
        ['rtg_boost_freq','重要任务组提频','freq','内核认定重要任务组活跃时，至少请求此频率；不是所有应用都触发。0 不通过本项抬升。'],
        ['adaptive_level_1','自适应一级频率','freq','启用自适应高档时，低于一级的请求会被抬到这里。实际还取用户值与内核请求的较大值。'],
        ['adaptive_low_freq','自适应低档频率','freq','自适应映射的中间台阶，不是 CPU 的硬性最低频率；只有高档启用等条件满足才参与。'],
        ['adaptive_high_freq','自适应高档频率','freq','给定源码以本项非零作为整个自适应台阶入口；设0跳过映射，即使内核仍保存台阶请求。重新开启后取用户/内核较大值；不同厂商实现仍需核实。它不是频率上限。']
    ].map(function (x) { return { key:x[0], label:x[1], type:x[2], help:x[3] }; });
    var keys = specs.map(function (x) { return x.key; });
    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
    /* 说明：v2.5.5 策略树 = 模式 × 频率区域 × 触摸阶段；defaults 仍是所有模式的公共基线。 */
    function block(config, mode, zone, phase, create) {
        if (mode === 'defaults') return config.defaults;
        var preset = config.presets[mode];
        if (!preset) throw Error('运行模式不存在');
        if (!preset.zones) throw Error('配置缺少频率区域，请按作者经验重新生成');
        var z = preset.zones[zone];
        if (!z) { if (!create) return {}; z = preset.zones[zone] = {}; }
        if (!z[phase] && create) z[phase] = {};
        return z[phase] || {};
    }
    function own(config, mode, zone, phase, group, policy, key) {
        var b=block(config,mode,zone,phase,false);
        return b[group] && b[group][policy] ? b[group][policy][key] : undefined;
    }
    function effective(config, mode, zone, phase, group, policy, key) {
        if (mode === 'defaults') return own(config,'defaults',zone,'*',group,policy,key);
        /* 说明：长阶段没配时沿用短阶段，与守护进程的编译规则一致。 */
        if (phase==='touch_long' && own(config,mode,zone,'touch_long',group,policy,key)===undefined) phase='touch_down';
        var v=own(config,mode,zone,phase,group,policy,key);
        if (v !== undefined) return v;
        if (phase !== '*') { v=own(config,mode,zone,'*',group,policy,key); if(v!==undefined)return v; }
        return own(config,'defaults','*',group,policy,key);
    }
    function set(config, mode, zone, phase, group, policy, key, value) {
        var next=clone(config), b=block(next,mode,zone,phase,true);
        b[group]=b[group] || {}; b[group][policy]=b[group][policy] || {};
        if (value === undefined || value === '') delete b[group][policy][key]; else b[group][policy][key]=value;
        if (!Object.keys(b[group][policy]).length) delete b[group][policy];
        if (!Object.keys(b[group]).length) delete b[group];
        return next;
    }
    function table(value, type) {
        var raw=String(value===undefined ? '' : value).trim();
        if (!raw) return [];
        if(type==='target') {
            var tokens=raw.split(/\s+/), rows=[{ boost:tokens.shift(), freq:'' }];
            tokens.forEach(function (x) { var p=x.split(':'); rows.push({freq:p[0],boost:p[1]===undefined?'':p[1]}); });
            return rows;
        }
        var t=raw.split(/\s+/), out=[];
        for(var i=0;i<t.length;i+=2)out.push({freq:t[i],load:t[i+1]===undefined?'':t[i+1]});
        return out;
    }
    function serialize(rows,type) {
        return type==='target' ? rows.map(function(r,i){return i ? r.freq+':'+r.boost : String(r.boost);}).join(' ') : rows.map(function(r){return r.freq+' '+r.load;}).join(' ');
    }
    function integer(v,min,max) { return /^-?\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v)>=min && Number(v)<=max; }
    function validate(key,value) {
        if(value===undefined)return '';
        var spec=specs.find(function(x){return x.key===key;});
        if (!spec && !/^scaling_(min|max)_freq$/.test(key)) return '未知参数';
        if(spec && (spec.type==='target'||spec.type==='zone')) {
            if(typeof value!=='string'||value.length>127)return '分段文本不能超过后端的 127 字节限制';
            if(spec.type==='target'&&!/^-?\d+(?: \d+:-?\d+)*$/.test(value))return '格式应为 基础值 频率:加减成，使用单个空格分隔';
            if(spec.type==='zone'&&!/^\d+ \d+(?: \d+ \d+)*$/.test(value))return '格式应为 边界 目标百分比，使用单个空格分隔';
            var rows=table(value,spec.type), prev=-1;
            if(!rows.length)return '至少保留一段';
            if(spec.type==='zone'&&rows.length>10)return '目标负载最多 10 段';
            for(var i=0;i<rows.length;i++) {
                var r=rows[i];
                if((spec.type==='zone'||i>0) && (!integer(r.freq,1,2147483647)||Number(r.freq)<=prev))return '分段边界须为递增的正整数 kHz';
                if(r.freq!==''&&r.freq!==undefined)prev=Number(r.freq);
                if(spec.type==='target'&&!integer(r.boost,-99,1000))return '界面保护范围为 -99～1000；已有原值不会自动改写';
                if(spec.type==='zone'&&!integer(r.load,1,100))return '目标负载必须为 1～100%';
            }
            return '';
        }
        if(spec&&spec.type==='signed')return integer(value,-100,1000)?'':'整体加减成须为 -100～1000';
        if(spec&&spec.type==='bool')return value===0||value===1?'':'预测负载只能选择开启或关闭';
        return integer(value,0,2147483647)?'':'请输入 0～2147483647 的整数';
    }
    /* 说明：v2.5.5：保存前把草稿整理成新结构并逐层校验。
     * 结构：global.zones（只含三区边界）+ presets[模式]{touch, zones{linear/decay/saturate}}，
     * 每个区域 = boost（每核组 bend/start/end）+ "*"/touch_down/touch_long/touch_up 阶段块。 */
    function prepare(before,draft) {
        if(!object(draft)||!object(draft.defaults)||!object(draft.presets)||!Array.isArray(draft.sysfs))throw Error('配置结构不完整');
        if(draft.version!=='author-touch-3')throw Error('这是旧版配置结构（'+(draft.version||'未标注')+'），请点「按作者经验重新生成」');
        var bounds=draft.global&&draft.global.zones;
        if(!object(bounds)||typeof bounds.enabled!=='boolean')throw Error('缺少频率区域配置');
        if(bounds.enabled&&(!integer(bounds.sample_ms,10,10000)||!object(bounds.clusters)))throw Error('频率区域的采集间隔或边界无效');
        var clusters=Object.keys(draft.defaults.policy_freq||{}).concat(Object.keys(draft.defaults.policy_walt||{}))
            .concat(Object.keys((bounds&&bounds.clusters)||{}));
        clusters=Array.from(new Set(clusters)).filter(function(id){return /^\d+$/.test(id);})
            .sort(function(a,b){return Number(a)-Number(b);});
        if(!clusters.length)throw Error('配置里没有任何核组');
        var next=clone(draft), touched={policy_freq:{},policy_walt:{}};
        /* 说明：v2.5.11 动态限最大频：global 只留总开关，时长按模式各自补齐与校验。
         * 老配置把时长写在 global 里，先当作缺省值搬到各模式，再清掉 global 里的时长。 */
        if(!object(next.global.maxfreq)) next.global.maxfreq={enabled:true};
        var mf=next.global.maxfreq;
        if(typeof mf.enabled!=='boolean')throw Error('动态限最大频的开关无效');
        MODE_LIST.forEach(function(mode){
            var preset=next.presets[mode];
            if(!object(preset.maxfreq)){
                var fallback=modeMaxfreq(draft,mode);
                preset.maxfreq={decay_hold_ms:fallback.decay_hold_ms,saturate_hold_ms:fallback.saturate_hold_ms};
            }
            if(!integer(preset.maxfreq.decay_hold_ms,20,5000)||!integer(preset.maxfreq.saturate_hold_ms,20,5000))
                throw Error(MODE_LABELS[mode]+'的限最大频时长需在 20～5000 毫秒');
        });
        delete next.global.maxfreq.decay_hold_ms;
        delete next.global.maxfreq.saturate_hold_ms;
        ['powersave','balance','performance','fast'].forEach(function(mode){
            var preset=next.presets[mode];
            if(!object(preset))throw Error('缺少运行模式 '+mode);
            var touch=preset.touch;
            if(!object(touch)||!integer(touch.long_press_ms,100,5000)||!integer(touch.release_delay_ms,0,2000))
                throw Error(mode+' 的触摸时序无效：长触摸 100～5000 毫秒，松手过渡 0～2000 毫秒');
            if(!object(preset.zones))throw Error(mode+' 缺少频率区域');
            ZONE_NAMES.forEach(function(zn){
                var z=preset.zones[zn.key];
                if(!object(z))throw Error(mode+' 缺少'+zn.label);
                if(!object(z.boost))z.boost={};
                clusters.forEach(function(id){
                    var b=z.boost[id];
                    if(!object(b))b=z.boost[id]=defaultZoneBoost();
                    if(!integer(b.bend,-100,100)||!integer(b.start,-1000,1000)||!integer(b.end,-1000,1000))
                        throw Error(mode+zn.label+'策略 '+id+' 的弯曲度/起点/终点无效');
                    var cb=bounds&&bounds.clusters&&bounds.clusters[id];
                    if(bounds.enabled&&(!cb||!integer(cb.linear_end,1,2147483647)||!integer(cb.decay_end,1,2147483647)||Number(cb.linear_end)>Number(cb.decay_end)))
                        throw Error('策略 '+id+' 缺少有效的频率区域边界');
                });
                ['*','touch_down','touch_up','touch_long'].forEach(function(phase){
                    var b=z[phase];
                    if(!object(b))return;
                    ['policy_freq','policy_walt'].forEach(function(group){
                        Object.keys(b[group]||{}).forEach(function(id){
                            if(!/^\d+$/.test(id))throw Error('CPU 策略编号无效');
                            Object.keys(b[group][id]).forEach(function(key){
                                var v=b[group][id][key];
                                var error=validate(key,v);
                                if(error)throw Error(mode+zn.label+' 策略 '+id+' '+key+'：'+error);
                                touched[group][id]=true;
                            });
                            var low=effective(next,mode,zn.key,phase,'policy_freq',id,'scaling_min_freq');
                            var high=effective(next,mode,zn.key,phase,'policy_freq',id,'scaling_max_freq');
                            if(low!==undefined&&high!==undefined&&Number(low)>Number(high))
                                throw Error('策略 '+id+' 最低频率不能高于最高频率');
                        });
                    });
                });
            });
        });
        /* 说明：通用基线也校验，但不参与「必须显式配置」的要求。 */
        ['policy_freq','policy_walt'].forEach(function(group){
            Object.keys(next.defaults[group]||{}).forEach(function(id){
                Object.keys(next.defaults[group][id]).forEach(function(key){
                    var v=next.defaults[group][id][key], error=validate(key,v);
                    if(error)throw Error('通用基础 策略 '+id+' '+key+'：'+error);
                    touched[group][id]=true;
                });
            });
        });
        Object.keys(touched).forEach(function(group){
            if(!Object.keys(touched[group]).length)return;
            var t=next.sysfs.find(function(x){return x.name===group;});
            var expected='/sys/devices/system/cpu/cpufreq/policy{policy}/'+(group==='policy_walt'?'walt/':'')+'{prop}';
            if(!t||t.path!==expected||!t.params)throw Error('策略模板不是受支持的标准路径，原文件未改写');
            var props=group==='policy_walt'?keys:['scaling_max_freq','scaling_min_freq'];
            if(!/^[a-z_][a-z0-9_]*(?:\|[a-z_][a-z0-9_]*)*$/.test(t.params.prop))throw Error('属性模板需要人工确认，界面不会覆盖自定义正则');
            t.params.prop=Array.from(new Set(t.params.prop.split('|').concat(props))).join('|');
            if(!/^\d+(?:\|\d+)*$/.test(t.params.policy))throw Error('策略模板需要人工确认，界面不会覆盖自定义正则');
            t.params.policy=Array.from(new Set(t.params.policy.split('|').concat(Object.keys(touched[group])))).sort(function(a,b){return Number(a)-Number(b);}).join('|');
        });
        return next;
    }
    function parseHardware(text) {
        var lines=String(text).trim().split(/\r?\n/), policies={};
        if(lines.pop()!=='END\t1')throw Error('CPU 信息读取不完整');
        lines.forEach(function(line){
            var p=line.split('\t'), id=p[1];
            if(!/^\d+$/.test(id))throw Error('CPU 信息格式无效');
            if(p[0]==='POLICY') {if(policies[id])throw Error('CPU 策略重复');policies[id]={id:id,values:{},walt:{},frequencies:[],frequencySource:'unavailable'};return;}
            var item=policies[id];if(!item)throw Error('CPU 策略顺序无效');
            if(p[0]==='VALUE')item.values[p[2]]=String(p[3]||'').trim();
            else if(p[0]==='WALT')item.walt[p[2]]=String(p[3]||'').trim();
            else if(p[0]==='FREQ') {item.frequencySource=p[2];item.frequencies=Array.from(new Set(String(p[3]||'').trim().split(/\s+/).filter(function(n){return integer(n,1,2147483647);}).map(Number))).sort(function(a,b){return a-b;});}
            else throw Error('CPU 信息字段无效');
        });
        return Object.keys(policies).sort(function(a,b){return Number(a)-Number(b);}).map(function(id){return policies[id];});
    }
    /* 说明：v2.5.5 频率区域模型。
     * global.zones 只存边界（enabled/sample_ms/clusters{id:{linear_end,decay_end}}）；
     * 每个模式每个区域内各有自己的 boost 公式与策略块，见 preset.zones[区域].boost。 */
    var ZONE_NAMES = [
        { key: 'linear',   label: '线性区',     hint: '频率与收益近似成正比' },
        { key: 'decay',    label: '收益递减区', hint: '频率继续提升，收益开始放缓' },
        { key: 'saturate', label: '饱和区',     hint: '频率很高，收益趋平' }
    ];
    var MODE_LIST = ['powersave', 'balance', 'performance', 'fast'];
    var MODE_LABELS = { powersave: '省电', balance: '均衡', performance: '性能', fast: '极速' };
    function defaultZoneBoost() { return { bend: 0, start: 0, end: 10 }; }
    function defaultBounds() { return { linear_end: 1000000, decay_end: 2000000 }; }
    /* 说明：bend 的文字描述，用于界面直观表达。 */
    function bendLabel(bend) {
        if (bend === 0) return '线性';
        if (bend > 0) return bend >= 70 ? '强先缓后快' : '先缓后快';
        return bend <= -70 ? '强先快后缓' : '先快后缓';
    }
    /* 说明：配置里出现过的所有核组 id（默认值、区域边界、各模式 boost 的并集）。 */
    function clustersOf(config) {
        var ids = {}, out = [];
        function add(id) { if (/^\d+$/.test(id) && !ids[id]) { ids[id] = 1; out.push(id); } }
        Object.keys((config && config.defaults && config.defaults.policy_freq) || {}).forEach(add);
        Object.keys((config && config.defaults && config.defaults.policy_walt) || {}).forEach(add);
        var bounds = config && config.global && config.global.zones;
        Object.keys((bounds && bounds.clusters) || {}).forEach(add);
        MODE_LIST.forEach(function(mode) {
            var z = config && config.presets && config.presets[mode] && config.presets[mode].zones;
            if (!z) return;
            ZONE_NAMES.forEach(function(zn) {
                Object.keys((z[zn.key] && z[zn.key].boost) || {}).forEach(add);
            });
        });
        return out.sort(function(a, b) { return Number(a) - Number(b); });
    }
    function zoneBounds(config) {
        var z = config && config.global && config.global.zones;
        return object(z) ? z : null;
    }
    function setZoneBounds(config, patch) {
        var next = clone(config);
        if (!object(next.global.zones)) next.global.zones = { enabled: true, sample_ms: 100, clusters: {} };
        Object.assign(next.global.zones, patch);
        return next;
    }
    function clusterBounds(config, id) {
        var z = zoneBounds(config);
        var c = z && z.clusters && z.clusters[id];
        return object(c) ? c : defaultBounds();
    }
    function setClusterBounds(config, id, patch) {
        var next = clone(config);
        if (!object(next.global.zones)) next.global.zones = { enabled: true, sample_ms: 100, clusters: {} };
        var zones = next.global.zones;
        if (!object(zones.clusters)) zones.clusters = {};
        if (!object(zones.clusters[id])) zones.clusters[id] = defaultBounds();
        Object.assign(zones.clusters[id], patch);
        return next;
    }
    /* 说明：v2.5.11 动态限最大频：总开关在 global.maxfreq.enabled，
     * 两个「顶住时长」按模式各自配置（presets[模式].maxfreq）。缺失时按缺省值兜底，
     * 与守护进程的默认一致（200/400）。 */
    var MAXFREQ_DEFAULT = { enabled: true, decay_hold_ms: 200, saturate_hold_ms: 400 };
    function maxfreqEnabled(config) {
        var g = config && config.global;
        var m = g && g.maxfreq;
        return object(m) ? !!m.enabled : true;
    }
    function setMaxfreqEnabled(config, enabled) {
        var next = clone(config);
        if (!object(next.global.maxfreq)) next.global.maxfreq = { enabled: !!enabled };
        next.global.maxfreq.enabled = !!enabled;
        /* 说明：旧配置把时长写在 global 里，这里顺手清掉（时长已经归各模式）。 */
        delete next.global.maxfreq.decay_hold_ms;
        delete next.global.maxfreq.saturate_hold_ms;
        return next;
    }
    /* 说明：某模式的顶住时长；模式没配就用 global 的旧值，再没有就用缺省。 */
    function modeMaxfreq(config, mode) {
        var preset = config && config.presets && config.presets[mode];
        var m = preset && preset.maxfreq;
        var g = config && config.global && config.global.maxfreq;
        function pick(key, fallback) {
            if (object(m) && m[key] !== undefined) return m[key];
            if (object(g) && g[key] !== undefined) return g[key];
            return fallback;
        }
        return { decay_hold_ms: pick('decay_hold_ms', MAXFREQ_DEFAULT.decay_hold_ms),
                 saturate_hold_ms: pick('saturate_hold_ms', MAXFREQ_DEFAULT.saturate_hold_ms) };
    }
    function setModeMaxfreq(config, mode, patch) {
        var next = clone(config);
        var preset = next.presets && next.presets[mode];
        if (!object(preset)) throw Error('运行模式不存在');
        if (!object(preset.maxfreq)) preset.maxfreq = modeMaxfreq(config, mode);
        Object.assign(preset.maxfreq, patch);
        return next;
    }
    function modeTouch(config, mode) {
        var p = config && config.presets && config.presets[mode];
        return object(p) && object(p.touch) ? p.touch : null;
    }
    function setModeTouch(config, mode, key, value) {
        var next = clone(config);
        var p = next.presets && next.presets[mode];
        if (!object(p)) throw Error('运行模式不存在');
        if (!object(p.touch)) p.touch = { long_press_ms: 500, release_delay_ms: 180 };
        p.touch[key] = value === '' ? '' : Number(value);
        return next;
    }
    /* 说明：某模式某区域某核组的 boost 公式；缺失时给默认值，不写回。 */
    function zoneBoost(config, mode, zone, cluster) {
        var z = config && config.presets && config.presets[mode] && config.presets[mode].zones
            && config.presets[mode].zones[zone];
        var b = z && z.boost && z.boost[cluster];
        return object(b) ? b : defaultZoneBoost();
    }
    function setZoneBoost(config, mode, zone, cluster, field, value) {
        var next = clone(config);
        var z = next.presets && next.presets[mode] && next.presets[mode].zones && next.presets[mode].zones[zone];
        if (!object(z)) throw Error('频率区域不存在');
        if (!object(z.boost)) z.boost = {};
        if (!object(z.boost[cluster])) z.boost[cluster] = defaultZoneBoost();
        z.boost[cluster][field] = value === '' ? 0 : Number(value);
        return next;
    }
    /* 说明：把某模式三个区域的 boost 与全局边界拼成一个 ClusterZone，供曲线预览使用。 */
    function clusterZoneView(config, mode, cluster) {
        var bounds = clusterBounds(config, cluster);
        var out = { linear_end: bounds.linear_end, decay_end: bounds.decay_end };
        ZONE_NAMES.forEach(function(zn) { out[zn.key] = zoneBoost(config, mode, zn.key, cluster); });
        return out;
    }
    CP.CpuPolicyModel={specs:specs,keys:keys,clone:clone,object:object,own:own,effective:effective,set:set,
        table:table,serialize:serialize,validate:validate,prepare:prepare,parseHardware:parseHardware,
        ZONE_NAMES:ZONE_NAMES,MODE_LIST:MODE_LIST,MODE_LABELS:MODE_LABELS,integer:integer,
        defaultZoneBoost:defaultZoneBoost,defaultBounds:defaultBounds,bendLabel:bendLabel,
        clustersOf:clustersOf,zoneBounds:zoneBounds,setZoneBounds:setZoneBounds,
        clusterBounds:clusterBounds,setClusterBounds:setClusterBounds,
        maxfreqEnabled:maxfreqEnabled,setMaxfreqEnabled:setMaxfreqEnabled,
        modeMaxfreq:modeMaxfreq,setModeMaxfreq:setModeMaxfreq,MAXFREQ_DEFAULT:MAXFREQ_DEFAULT,
        modeTouch:modeTouch,setModeTouch:setModeTouch,zoneBoost:zoneBoost,setZoneBoost:setZoneBoost,
        clusterZoneView:clusterZoneView};
})(window.CP=window.CP||{});