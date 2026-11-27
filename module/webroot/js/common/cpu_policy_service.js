/* 说明：CPU 配置基础设施只负责设备发现与配置事务；所有页面共享同一写入队列。 */
(function (CP) {
    'use strict';
    var S=CP.KsuService, base=CP.MODULE_DIR, queue=Promise.resolve();
    function quote(v){return "'"+String(v).replace(/'/g,"'\\''")+"'";}
    function enqueue(run){var task=queue.then(run,run);queue=task.catch(function(){});return task;}
    async function read(allowInvalid) {
        var r=await S.exec('sh '+base+'/bin/config_io.sh read');
        if(!r||r.errno!==0)throw Error((r&&r.stderr)||'CPU 配置读取失败，请检查 Root 授权');
        var match=/^CPPOLICY\t([a-f0-9]{64})\r?\n([\s\S]*)\r?\nCPEND\t([a-f0-9]{64})\s*$/.exec(String(r.stdout||''));
        if(!match)throw Error('CPU 配置读取回执不完整或格式无效，请检查模块文件与 Root 桥接');
        if(match[1]!==match[3])throw Error('配置读取期间发生变化，请重新读取');
        var config;
        try{config=JSON.parse(match[2]);}catch(e){if(!allowInvalid)throw Error('CPU 配置不是有效 JSON，原文件未修改');}
        if(!config||!config.defaults||!config.presets||!config.global){if(!allowInvalid)throw Error('CPU 配置结构不完整');config=null;}
        return {config:config,revision:match[1]};
    }
    async function save(snapshot,config) {
        var json=JSON.stringify(config,null,2);
        if(json.length>131072)throw Error('配置超过界面 128KB 保存限制');
        var token=Date.now()+'_'+Math.random().toString(36).slice(2),tmp=base+'/.cpu-policy-candidate-'+token+'.json';
        try {
            var r=await S.exec("umask 077; printf '%s' "+quote(json)+' > '+quote(tmp)+' && cat '+quote(tmp));
            if(!r||r.errno!==0||JSON.stringify(JSON.parse(r.stdout))!==JSON.stringify(config))throw Error('候选配置回读失败，原文件未修改');
            var committed=await S.exec('sh '+base+'/bin/config_io.sh save '+quote(snapshot.revision)+' '+quote(token));
            if(!committed||committed.errno!==0)throw Error((committed&&committed.stderr)||'配置提交失败，原文件未修改');
            var m=/^CPSAVED\t([a-f0-9]{64})\t([^\r\n]+)\s*$/.exec(String(committed.stdout).trim());
            if(!m)throw Error('配置提交回执不完整，请重新读取确认保存状态');
            return {ok:true,revision:m[1],backup:m[2],config:config,msg:'配置已保存，等待守护进程热加载；硬件效果请查看实际读回'};
        } finally {try{await S.exec('rm -f '+quote(tmp));}catch(e) {}}
    }
    S.readCpuPolicy=function(){return enqueue(function(){return read(false);});};
    /* 说明：安装与恢复调用同一生成器；生成不写配置，快照仅用于后续保存的并发校验。 */
    S.generateAuthorPolicy=function(){
        return enqueue(async function(){
            var snapshot=await read(true),level=snapshot.config&&snapshot.config.global.log_level;
            if(!Number.isInteger(level)||level<0||level>3)level=0;
            var r=await S.exec('sh '+base+'/bin/author_policy.sh '+level),config;
            if(!r||r.errno!==0)throw Error((r&&r.stderr)||'作者默认配置生成失败，原文件未修改');
            try{config=JSON.parse(r.stdout);}catch(e){throw Error('作者默认配置回执不完整，原文件未修改');}
            /* 说明：v2.5.5：默认生成器输出 author-touch-3（模式 × 频率区域），校验随之收紧。 */
            if(!config||config.version!=='author-touch-3'||!config.global||config.global.log_level!==level||
               !config.global.zones||!config.defaults||!config.defaults.policy_freq||!Object.keys(config.defaults.policy_freq).length)throw Error('作者默认配置结构无效');
            var zonesOk=config.presets&&['powersave','balance','performance','fast'].every(function(m){
                var p=config.presets[m];
                return p&&p.touch&&p.zones&&p.zones.linear&&p.zones.decay&&p.zones.saturate;
            });
            if(!zonesOk)throw Error('作者默认配置缺少模式或频率区域');
            config=CP.CpuPolicyModel.prepare(config,config);
            return {snapshot:{config:snapshot.config,revision:snapshot.revision,authorBase:CP.CpuPolicyModel.clone(config)},config:config};
        });
    };
    S.readCpuHardware=async function(){
        var r=await S.exec('sh '+base+'/bin/cpu_info.sh');
        if(!r||r.errno!==0)throw Error((r&&r.stderr)||'CPU 频率读取失败，请检查 Root 授权');
        return CP.CpuPolicyModel.parseHardware(r.stdout);
    };
    S.saveCpuPolicy=function(snapshot,draft){
        var frozen=CP.CpuPolicyModel.clone(draft);
        return enqueue(async function(){
            var current=await read(!snapshot.config);
            if(current.revision!==snapshot.revision)throw Error('配置已被其他页面或程序修改，请重新读取后调整；草稿仍保留');
            return save(current,CP.CpuPolicyModel.prepare(snapshot.authorBase||(snapshot.config||frozen),frozen));
        });
    };
    S.updateLogLevel=function(level){
        return enqueue(async function(){
            if(!Number.isInteger(level)||level<0||level>3)throw Error('日志级别无效');
            var current=await read(),config=CP.CpuPolicyModel.clone(current.config);config.global.log_level=level;
            return save(current,config);
        });
    };
    /* 说明：旧写入入口仅允许变更日志级别，合并到最新文件，避免覆盖配置页保存。 */
    S.writeJson=async function(path,obj){
        if(path!==CP.CONFIG_PATH||!obj||!obj.global)return {ok:false,msg:'配置写入范围无效'};
        try{return await S.updateLogLevel(obj.global.log_level);}catch(e){return {ok:false,msg:e.message};}
    };
})(window.CP=window.CP||{});