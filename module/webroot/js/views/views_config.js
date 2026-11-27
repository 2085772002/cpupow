/* 说明：配置页只编排领域模型与基础设施，设备命令和参数校验不写在视图里。
 * v2.5.5 结构：页面开头是三个能效区域（线性/收益递减/饱和）的边界；
 * 四个模式里，每个模式开头是自己的触摸时序，随后是三个区域——
 * 每个区域各带一套动态 boost 公式与该区域自己的触摸阶段配置。 */
(function(CP){
    'use strict';
    var h=CP.h,M=CP.CpuPolicyModel,S=CP.KsuService;
    var useState=React.useState,useRef=React.useRef,useEffect=React.useEffect;

    /* 说明：每个区域各自的触摸阶段。常规基础必配，长触摸缺失时沿用短触摸（与守护进程一致）。 */
    var PHASES=[
        {key:'*',label:'常规基础',hint:'无触摸时的下发内容'},
        {key:'touch_down',label:'短触摸',hint:'按下到长触摸阈值之间'},
        {key:'touch_long',label:'长触摸',hint:'按住超过阈值；未配置时沿用短触摸'},
        {key:'touch_up',label:'松手过渡',hint:'松手后短暂保持，再回到常规基础'}
    ];

    function FrequencyField(p){
        var value=p.value===undefined?'':String(p.value),items=p.frequencies||[];
        return h('div',{className:'cpu-frequency'},[
            h('select',{'aria-label':p.label+' 可用频率',disabled:p.disabled,value:items.indexOf(Number(value))>=0||(p.zero&&value==='0')||(p.all&&value==='2147483647')?value:'custom',onChange:function(e){if(e.target.value!=='custom')p.onChange(e.target.value);}},[
                h('option',{key:'custom',value:'custom'},value===''?'请选择频率或输入数值':'保留当前 / 自定义'),
                p.zero?h('option',{key:'zero',value:'0'},'0 · 不额外请求'):null,
                p.all?h('option',{key:'all',value:'2147483647'},'覆盖全部需求'):null
            ].concat(items.map(function(f){return h('option',{key:f,value:String(f)},(f/1000).toLocaleString('zh-CN')+' MHz');}))),
            h('div',{className:'cpu-inline'},[h('input',{type:'number',inputMode:'numeric',step:1,min:0,'aria-label':p.label,value:value,disabled:p.disabled,onChange:function(e){p.onChange(e.target.value);}}),h('span',null,'kHz')])
        ]);
    }
    function TableEditor(p){
        var buffer=useState(function(){return M.table(p.value,p.type);}),rows=buffer[0],setRows=buffer[1],last=useRef(p.value),isTarget=p.type==='target';
        useEffect(function(){if(p.value!==last.current){last.current=p.value;setRows(M.table(p.value,p.type));}},[p.value,p.type]);
        function publish(next){var value=M.serialize(next,p.type);last.current=value;setRows(next);p.onChange(value);}
        function change(i,key,value){var next=rows.map(function(r){return Object.assign({},r);});next[i][key]=value;publish(next);}
        return h('div',{className:'cpu-table'},[
            h('p',{className:'cpu-help'},isTarget?'首行是低需求基础加减成；后续行从指定需求频率标记开始采用对应加减成。':'每行是需求等效频率上边界与目标百分比；最后可选择“覆盖全部需求”。'),
            rows.map(function(r,i){return h('div',{key:i,className:'cpu-table-row'},[
                isTarget&&i===0?h('span',null,'最低需求段'):h(FrequencyField,{label:p.label+' 第'+(i+1)+'段边界',value:r.freq,frequencies:p.frequencies,disabled:p.disabled,all:!isTarget,onChange:function(v){change(i,'freq',v);}}),
                h('label',null,[isTarget?'加减成 %':'目标负载 %',h('input',{type:'number',step:1,'aria-label':p.label+' 第'+(i+1)+'段百分比',value:isTarget?r.boost:r.load,disabled:p.disabled,onChange:function(e){change(i,isTarget?'boost':'load',e.target.value);}})]),
                h('button',{type:'button',disabled:p.disabled||(isTarget&&i===0),onClick:function(){publish(rows.filter(function(_,j){return j!==i;}));},'aria-label':'移除'+p.label+'第'+(i+1)+'段'},'移除')
            ]);}),
            h('button',{type:'button',disabled:p.disabled||(!isTarget&&rows.length>=10),onClick:function(){var next=rows.slice();next.push(isTarget?{freq:'',boost:'0'}:{freq:String(rows.length?Math.min(2147483647,Number(rows[rows.length-1].freq)+1):(p.frequencies[0]||2147483647)),load:'80'});publish(next);}},'＋ 添加分段'),
            h('details',null,[h('summary',null,'查看 / 编辑参数原文'),h('textarea',{'aria-label':p.label+' 原文',value:p.value===undefined?'':String(p.value),disabled:p.disabled,onChange:function(e){p.onChange(e.target.value);},spellCheck:false})])
        ]);
    }
    /* 说明：分区 boost 曲线：横轴=实际频率(min→max)，纵轴=boost，虚线=0 基线，
     * 两条竖线标出分区边界。三区合并成一条完整曲线，能直接看出整段频率的 boost 走向。 */
    function zoneBendFactor(bend,t){
        if(!bend)return t;
        var k=Math.min(Math.abs(bend)/100,1),bell=t-t*t;
        return bend>0?t-k*bell:t+k*bell;
    }
    /* 说明：按频率取该频率所属区与 boost 值，与 C 侧 zone_index/zone_compute_boost 一致。
     * 分区边界统一钳制到 [minFreq,maxFreq]，边界配超范围时曲线仍能走到区终点值。 */
    function zoneBoostAt(cz,minFreq,maxFreq,freq){
        var le=Number(cz.linear_end)||0, de=Number(cz.decay_end)||0;
        var linear=Math.min(Math.max(le,minFreq),maxFreq);
        var decay=Math.min(Math.max(de,linear),maxFreq);
        var idx = freq<=linear?0:(freq<=decay?1:2);
        var key=M.ZONE_NAMES[idx].key, b=cz[key]||M.defaultZoneBoost();
        var lo,hi;
        if(idx===0){lo=minFreq;hi=linear;}else if(idx===1){lo=linear;hi=decay;}else{lo=decay;hi=maxFreq;}
        if(hi<=lo)return {idx:idx,boost:Number(b.start)};
        var f=Math.min(Math.max((freq-lo)/(hi-lo),0),1);
        return {idx:idx, boost:Math.round(Number(b.start)+(Number(b.end)-Number(b.start))*zoneBendFactor(Number(b.bend),f))};
    }
    const ZoneOverviewChart = React.memo(function ZoneOverviewChart(p){
        var cz=p.cluster, minFreq=Number(p.minFreq)||0, maxFreq=Number(p.maxFreq)||0;
        if(!cz||maxFreq<=minFreq)return h('p',{className:'cpu-help'},'缺少硬件频率范围，无法绘制曲线。');
        var W=320,H=150,PADL=34,PADR=10,PADT=12,PADB=22,steps=72;
        var pts=[],boostMin=0,boostMax=0,first=true;
        for(var i=0;i<=steps;i++){
            var freq=minFreq+(maxFreq-minFreq)*i/steps;
            var r=zoneBoostAt(cz,minFreq,maxFreq,freq);
            if(first){boostMin=r.boost;boostMax=r.boost;first=false;}
            else{boostMin=Math.min(boostMin,r.boost);boostMax=Math.max(boostMax,r.boost);}
            pts.push({freq:freq,boost:r.boost});
        }
        var span=(boostMax-boostMin)||1;
        boostMin-=span*0.12; boostMax+=span*0.12; span=boostMax-boostMin;
        function X(freq){return PADL+(W-PADL-PADR)*(freq-minFreq)/(maxFreq-minFreq);}
        function Y(boost){return PADT+(H-PADT-PADB)*(1-(boost-boostMin)/span);}
        var path=pts.map(function(q){return X(q.freq).toFixed(1)+','+Y(q.boost).toFixed(1);}).join(' ');
        var zeroY=(0>=boostMin&&0<=boostMax)?Y(0):null;
        var boundaries=[];
        [Number(cz.linear_end),Number(cz.decay_end)].forEach(function(f){
            if(f>minFreq&&f<maxFreq)boundaries.push(f);
        });
        var ticks=[minFreq].concat(boundaries,[maxFreq]);
        return h('div',{className:'cpu-zone-chart'},[
            h('svg',{viewBox:'0 0 '+W+' '+H,width:'100%',height:H,role:'img','aria-label':p.label+'完整 boost 曲线'},[
                zeroY!=null?h('line',{x1:PADL,y1:zeroY.toFixed(1),x2:W-PADR,y2:zeroY.toFixed(1),stroke:'#cbd5e1','stroke-width':1,strokeDasharray:'4,3'}):null,
                boundaries.map(function(f,i){return h('line',{key:'b'+i,x1:X(f).toFixed(1),y1:PADT,x2:X(f).toFixed(1),y2:H-PADB,stroke:'#c4b5fd','stroke-width':1,strokeDasharray:'4,3'});}),
                h('polyline',{points:path,fill:'none',stroke:'#7c3aed','stroke-width':2.5,strokeLinejoin:'round',strokeLinecap:'round'}),
                M.ZONE_NAMES.map(function(zn,idx){
                    var lo=idx===0?minFreq:(idx===1?Math.max(Number(cz.linear_end),minFreq):Math.max(Number(cz.decay_end),minFreq));
                    var hi=idx===0?Math.min(Number(cz.linear_end),maxFreq):(idx===1?Math.min(Number(cz.decay_end),maxFreq):maxFreq);
                    if(hi<=lo)return null;
                    var mid=(lo+hi)/2, r=zoneBoostAt(cz,minFreq,maxFreq,mid);
                    return h('g',{key:zn.key},[
                        h('circle',{cx:X(mid).toFixed(1),cy:Y(r.boost).toFixed(1),r:3.5,fill:'#7c3aed'}),
                        h('text',{x:X(mid).toFixed(1),y:(Y(r.boost)-8).toFixed(1),textAnchor:'middle',fontSize:10,fill:'#6d28d9'},r.boost+'%')
                    ]);
                }),
                h('text',{x:PADL-4,y:(PADT+4),textAnchor:'end',fontSize:9,fill:'#94a3b8'},Math.round(boostMax)+'%'),
                h('text',{x:PADL-4,y:(H-PADB),textAnchor:'end',fontSize:9,fill:'#94a3b8'},Math.round(boostMin)+'%'),
                ticks.map(function(f,i){
                    return h('text',{key:'t'+i,x:X(f).toFixed(1),y:H-PADB+14,textAnchor:i===0?'start':(i===ticks.length-1?'end':'middle'),fontSize:9,fill:'#94a3b8'},(f/1000).toFixed(0)+'M');
                })
            ]),
            h('div',{className:'cpu-zone-chart-legend'},[
                h('span',null,'● 紫线：全频段 boost 走向'),
                h('span',null,'┆ 竖虚线：分区边界'),
                h('span',null,'数字：该区中点 boost')
            ])
        ]);
    });
    /* 说明：单区小图保留，作为该区的独立形状参考。 */
    const ZoneCurvePreview = React.memo(function ZoneCurvePreview(p){
        var b=p.boost,W=200,H=64,PAD=8,steps=48,pts=[];
        var lo=Math.min(b.start,b.end),hi=Math.max(b.start,b.end),range=(hi-lo)||1;
        var tone=b.start<=b.end?'#f59e0b':'#10b981';
        function pt(t){
            var boost=b.start+(b.end-b.start)*zoneBendFactor(b.bend,t);
            var x=PAD+(W-2*PAD)*t;
            var y=PAD+(H-2*PAD)*(1-(boost-lo)/range);
            return [x,y];
        }
        for(var i=0;i<=steps;i++){var q=pt(i/steps);pts.push(q[0].toFixed(1)+','+q[1].toFixed(1));}
        var s=pt(0),e=pt(1),mid=pt(0.5);
        var zeroY=0>=lo&&0<=hi?PAD+(H-2*PAD)*(1-(0-lo)/range):null;
        return h('div',{className:'cpu-zone-curve-wrap'},[
            h('svg',{width:W,height:H,viewBox:'0 0 '+W+' '+H,'aria-label':p.label+'曲线'},[
                zeroY!=null?h('line',{x1:PAD,y1:zeroY.toFixed(1),x2:W-PAD,y2:zeroY.toFixed(1),stroke:'#94a3b8','stroke-width':1,strokeDasharray:'3,3'}):null,
                h('polyline',{points:pts.join(' '),fill:'none',stroke:tone,'stroke-width':2.5,strokeLinejoin:'round',strokeLinecap:'round'}),
                h('circle',{cx:s[0],cy:s[1],r:3,fill:tone}),
                h('circle',{cx:mid[0],cy:mid[1],r:3,fill:tone}),
                h('circle',{cx:e[0],cy:e[1],r:3,fill:tone})
            ]),
            h('div',{className:'cpu-zone-curve-label'},[
                h('span',{style:{color:tone}},b.start+'% 起'),
                h('span',{className:'cpu-zone-curve-dir'},'中点 '+Math.round(Number(b.start)+(Number(b.end)-Number(b.start))*zoneBendFactor(Number(b.bend),0.5))+'%'),
                h('span',{style:{color:tone}},b.end+'% 终')
            ])
        ]);
    });

    /* 说明：弯曲度编辑。v2.5.5 删掉了分档预设按钮，只保留数字框；
     * 滑条默认收起（收纳），点「展开滑条」才出现，避免在卡片上滑动时误改参数。 */
    function BendEditor(p){
        var open=p.open;
        var value=Number(p.value);
        if(!isFinite(value))value=0;
        return h('div',{className:'cpu-bend-row'},[
            h('div',{className:'cpu-bend-line'},[
                h('span',{className:'cpu-bend-title'},'弯曲度'),
                h('input',{type:'number',step:1,min:-100,max:100,className:'cpu-bend-number','aria-label':p.label+'弯曲度',disabled:p.disabled,value:p.value,onChange:function(e){p.onChange(e.target.value);}}),
                h('button',{type:'button',disabled:p.disabled,className:'cpu-bend-toggle'+(open?' is-open':''),'aria-expanded':open?'true':'false',onClick:function(){p.onToggle(!open);}},'滑条'+(open?' ‹ 收起':' › 展开'))
            ]),
            h('p',{className:'cpu-bend-state'},M.bendLabel(value)+(open?'':'（0 线性，正数先缓后快，负数先快后缓）')),
            open?h('input',{type:'range',min:-100,max:100,step:1,className:'cpu-bend-slider','aria-label':p.label+'弯曲度滑条',disabled:p.disabled,
                value:value,style:{'--pct':((value+100)/2)+'%'},onChange:function(e){p.onChange(e.target.value);}}):null
        ]);
    }

    function ConfigPage(){
        var state=useState(null),snapshot=state[0],setSnapshot=state[1];
        var ds=useState(null),draft=ds[0],setDraft=ds[1];
        var hs=useState([]),hardware=hs[0],setHardware=hs[1];
        var es=useState(''),error=es[0],setError=es[1];
        var he=useState(''),hardwareError=he[0],setHardwareError=he[1];
        var bs=useState(false),busy=bs[0],setBusy=bs[1];
        var ss=useState(''),message=ss[0],setMessage=ss[1];
        /* 说明：v2.5.5：编辑轴改成「模式 → 区域 → 阶段」。阶段按区域各自记忆。 */
        var ms=useState('balance'),mode=ms[0],setMode=ms[1];
        var ph=useState({linear:'*',decay:'*',saturate:'*'}),phaseMap=ph[0],setPhaseMap=ph[1];
        var ids=useState(''),policy=ids[0],setPolicy=ids[1];
        var dos=useState(false),draftOpen=dos[0],setDraftOpen=dos[1];
        var gos=useState(false),generalOpen=gos[0],setGeneralOpen=gos[1];
        /* 说明：details 的展开状态。收起时完全不创建内部节点——配置页参数多，
         * 全量铺开会让每次显示都重排整棵子树。 */
        var ops=useState({}),openMap=ops[0],setOpenMap=ops[1];
        function markOpen(key,open){setOpenMap(function(prev){return prev[key]===open?prev:Object.assign({},prev,{[key]:open});});}
        var mounted=useRef(true),loading=useRef(false),loaded=useRef(false),saving=useRef(false);
        var readEpoch=useRef(0),hardwareEpoch=useRef(0);
        var scope=CP.usePageScope();
        var hls=useState(true),hardwareLoading=hls[0],setHardwareLoading=hls[1];
        /* 说明：首次进入只等配置读完就撤遮罩；设备频率信息后到时再补渲染频率下拉。 */
        CP.usePageLoading(!draft && !error);
        var dirty=React.useMemo(function(){
            return !!draft&&!!snapshot&&JSON.stringify(draft)!==JSON.stringify(snapshot.config);
        },[draft,snapshot]);
        useEffect(function(){return function(){mounted.current=false;};},[]);
        var hardwareAt=useRef(0);
        async function refreshHardware(){
            var epoch=++hardwareEpoch.current;
            setHardwareLoading(true);
            try{var data=await S.readCpuHardware();if(mounted.current&&epoch===hardwareEpoch.current){setHardware(data);setHardwareError('');hardwareAt.current=Date.now();}}
            catch(e){if(mounted.current&&epoch===hardwareEpoch.current)setHardwareError(e.message);}
            finally{if(mounted.current&&epoch===hardwareEpoch.current)setHardwareLoading(false);}
        }
        async function load(replace){
            if(loading.current||saving.current)return;
            if(replace&&dirty&&!window.confirm('重新读取会放弃尚未保存的草稿，是否继续？'))return;
            var epoch=++readEpoch.current;
            loading.current=true;setBusy(true);setError('');
            try{var value=await S.readCpuPolicy();if(mounted.current&&epoch===readEpoch.current){
                if(!value||!value.config||value.config.version!=='author-touch-3'){
                    setSnapshot(value);setDraft(null);
                    setError('当前配置是旧版结构（'+(value&&value.config&&value.config.version||'未标注')+'），界面不再编辑它。请点「按作者经验重新生成」，确认后保存以升级到新模式×区域结构。');
                }else{
                    setSnapshot(value);setDraft(M.clone(value.config));loaded.current=true;
                    setMessage('已读取保存配置；尚未修改设备参数');
                }
            }}
            catch(e){if(mounted.current&&epoch===readEpoch.current)setError(e.message);}
            finally{if(epoch===readEpoch.current){loading.current=false;if(mounted.current)setBusy(false);}}
        }
        CP.usePageTask(function(){
            hardwareEpoch.current++;
            if(!loaded.current)load(false);
            /* 说明：cpu_info.sh 要遍历上百个 sysfs 节点，是最重的一次读取。
             * 预热阶段不跑；真正进入时也延后 1 秒——用户若是路过本页（点开就切走），
             * 这一次重读根本不会启动，切页也就不会被它拖住。 */
            var hwTimer=setTimeout(function(){
                if(scope.isActive() && !scope.warming && Date.now()-hardwareAt.current>30000) refreshHardware();
            },1000);
            return function(){
                clearTimeout(hwTimer);
                readEpoch.current++;hardwareEpoch.current++;loading.current=false;
                if(!saving.current)setBusy(false);
            };
        },[]);
        /* 说明：核组来源：硬件发现 + 配置里出现过的核组（默认值、边界、各模式 boost），
         * 避免硬件暂时读不到时把用户已配的东西藏掉。 */
        var idsAll=React.useMemo(function(){
            var set=new Set(hardware.map(function(x){return x.id;}));
            if(draft)M.clustersOf(draft).forEach(function(id){set.add(id);});
            return Array.from(set).sort(function(a,b){return Number(a)-Number(b);});
        },[hardware,draft]);
        useEffect(function(){if(idsAll.length&&idsAll.indexOf(policy)<0)setPolicy(idsAll[0]);},[idsAll.join('|'),policy]);
        var device=hardware.find(function(x){return x.id===policy;}),freqs=device?device.frequencies:[];
        var bounds=draft?M.zoneBounds(draft):null;
        /* 说明：v2.5.8 动态限最大频；v2.5.11 起总开关是全局的，两个时长按模式各自配置。
         * 开启时「最高频率」不再写入，由分界线动态决定上限。 */
        var maxfreqOn=draft?M.maxfreqEnabled(draft):true;
        var modeMaxfreq=draft?M.modeMaxfreq(draft,mode):{decay_hold_ms:M.MAXFREQ_DEFAULT.decay_hold_ms,
                                                        saturate_hold_ms:M.MAXFREQ_DEFAULT.saturate_hold_ms};

        function update(ctx,group,key,value){
            setDraft(function(previous){
                return M.set(previous,ctx.mode,ctx.zone,ctx.phase,group,ctx.policy,key,value===''?undefined:(/^(target_loads|zone_max_util_pct)$/.test(key)?value:Number(value)));
            });
            setMessage('草稿未保存');
        }
        function updateTouch(key,value){
            setDraft(function(previous){
                try{return M.setModeTouch(previous,mode,key,value);}catch(e){return previous;}
            });
            setMessage('触摸时序草稿未保存');
        }
        function updateBounds(patch){
            setDraft(function(previous){return M.setZoneBounds(previous,patch);});
            setMessage('频率区域草稿未保存');
        }
        function updateClusterBounds(id,patch){
            setDraft(function(previous){return M.setClusterBounds(previous,id,patch);});
            setMessage('频率区域草稿未保存');
        }
        function updateMaxfreqEnabled(enabled){
            setDraft(function(previous){return M.setMaxfreqEnabled(previous,enabled);});
            setMessage('动态限最大频草稿未保存');
        }
        function updateModeMaxfreq(patch){
            setDraft(function(previous){
                try{return M.setModeMaxfreq(previous,mode,patch);}catch(e){return previous;}
            });
            setMessage('动态限最大频时长草稿未保存');
        }
        function updateBoost(zoneKey,field,value){
            setDraft(function(previous){
                try{return M.setZoneBoost(previous,mode,zoneKey,policy,field,value);}catch(e){return previous;}
            });
            setMessage('动态 boost 草稿未保存');
        }
        async function regenerate(){
            if(loading.current||saving.current)return;
            if(!window.confirm('按本机频点及 WALT 机制重新生成完整作者默认草稿？这会替换当前 CPU 草稿及原有自定义策略，但保留应用设置和日志级别；可读的 WALT 参数将显式重设，点击保存前不写设备。'))return;
            saving.current=true;setBusy(true);setError('');
            try{
                var generated=await S.generateAuthorPolicy();
                if(mounted.current){
                    setSnapshot(generated.snapshot);setDraft(M.clone(generated.config));loaded.current=true;
                    setMessage('已生成四档作者默认草稿：每档含触摸时序与线性/收益递减/饱和三个区域，每个区域各有一整套常规与触摸阶段配置；推进器开启，boost 由区域公式动态计算。尚未保存。');
                }
                refreshHardware();
            }catch(e){if(mounted.current)setError(e.message||'生成失败，原配置与草稿未修改');}
            finally{saving.current=false;if(mounted.current)setBusy(false);}
        }
        async function submit(){
            if(!draft||!dirty||saving.current||loading.current)return;
            saving.current=true;setBusy(true);setError('');
            try{
                var result=await S.saveCpuPolicy(snapshot,draft);
                if(mounted.current){setSnapshot({config:result.config,revision:result.revision});setDraft(M.clone(result.config));setMessage(result.msg+'。回退副本：'+result.backup);}
                refreshHardware();
            }catch(e){if(mounted.current)setError(e.message||'保存失败，草稿保留');}
            finally{saving.current=false;if(mounted.current)setBusy(false);}
        }

        /* 说明：单个参数的编辑控件。ctx 决定读写哪一层（模式/区域/阶段/核组），
         * 通用基础层用 ctx.mode='defaults'，不理会区域与阶段。 */
        function field(spec,group,ctx){
            var own=M.own(draft,ctx.mode,ctx.zone,ctx.phase,group,ctx.policy,spec.key);
            var reference=M.effective(draft,ctx.mode,ctx.zone,ctx.phase,group,ctx.policy,spec.key);
            var dev=hardware.find(function(x){return x.id===ctx.policy;});
            var actual=group==='policy_walt'?(dev&&dev.walt[spec.key]):(dev&&dev.values[spec.key]);
            var unsupported=!!dev&&group==='policy_walt'&&(actual===undefined||actual==='missing'||actual==='unreadable');
            /* 说明：动态限最大频开启时，scaling_max_freq 由运行时限频器接管，这里只展示不写。 */
            var ownedByMaxfreq=maxfreqOn&&group==='policy_freq'&&spec.key==='scaling_max_freq'&&ctx.mode!=='defaults';
            var disabled=busy||!dev||unsupported||ownedByMaxfreq;
            var val=own===undefined?'':own;
            function change(v){update(ctx,group,spec.key,v);}
            var control;
            if(spec.type==='freq')control=h(FrequencyField,{label:spec.label,value:val,frequencies:dev?dev.frequencies:[],disabled:disabled,zero:group==='policy_walt',onChange:change});
            else if(spec.type==='bool')control=h('select',{'aria-label':spec.label,value:String(val),disabled:disabled,onChange:function(e){change(e.target.value);}},[h('option',{value:''},ctx.mode==='defaults'?'未设置':'本层不覆盖'),h('option',{value:'0'},'关闭'),h('option',{value:'1'},'开启')]);
            else if(spec.type==='target'||spec.type==='zone')control=h(TableEditor,{key:[ctx.mode,ctx.zone,ctx.phase,ctx.policy,spec.key].join('-'),label:spec.label,type:spec.type,value:val,frequencies:dev?dev.frequencies:[],disabled:disabled,onChange:change});
            else control=h('div',{className:'cpu-inline'},[h('input',{type:'number',step:1,'aria-label':spec.label,value:val,disabled:disabled,placeholder:'本层未设置',onChange:function(e){change(e.target.value);}}),h('span',null,spec.type==='time'?'微秒':'%')]);
            var localError=own===undefined?'':M.validate(spec.key,own);
            var okey=[ctx.mode,ctx.zone,ctx.phase,ctx.policy,spec.key].join(':');
            var fieldOpen=!!openMap[okey];
            return h('details',{key:okey,className:'cpu-setting',onToggle:function(e){markOpen(okey,e.currentTarget.open);}},[
                h('summary',null,[h('span',null,spec.label),h('small',null,own===undefined?'本层未设置':String(own))]),
                fieldOpen?h(React.Fragment,null,[
                    h('code',null,spec.key),h('p',{className:'cpu-help'},spec.help),
                    ownedByMaxfreq?h('p',{className:'cpu-warn'},'动态限最大频已开启：本项不写入，上限由两条分界线按档位动态给出。关掉动态限频后本项恢复生效。'):null,
                    h('p',{className:'cpu-readback'},'设备当前读回：'+(!dev?'未取得':actual==='missing'?'节点不存在':actual==='unreadable'?'无读取权限':actual===undefined?'未取得':actual)),
                    unsupported?h('p',{className:'cpu-warn'},'此设备没有可读的该参数节点，配置保留但不新增修改。'):null,
                    !dev?h('p',{className:'cpu-warn'},'未取得此策略硬件信息，配置保留。刷新设备信息成功后可调整。'):null,
                    own===undefined?h('p',{className:'cpu-help'},(ctx.mode!=='defaults'&&ctx.phase!=='*'?'本阶段未覆盖；受触摸管理的项目按该区域基线恢复，其他项目不写。缺失长阶段沿用短触摸。参考：':'继承参考：')+(reference===undefined?'未配置，不主动写入':reference)):null,
                    control,
                    own!==undefined?h('button',{type:'button',disabled:busy,onClick:function(){change('');}},ctx.mode==='defaults'?'移除本项配置':'恢复本层不覆盖'):null,
                    localError?h('p',{className:'cpu-warn'},'原值保留提示：'+localError):null,
                    spec.key==='hispeed_load'&&Number(own)>100?h('p',{className:'cpu-warn'},'文件仍保留 '+own+'，此内核实际最多按 100 处理，页面不会静默改值。'):null
                ]):null
            ]);
        }
        function paramList(ctx){
            var dev=hardware.find(function(x){return x.id===ctx.policy;});
            return h(React.Fragment,null,[
                h('h4',null,'CPU 频率范围'),
                field({key:'scaling_min_freq',label:'最低频率',type:'freq',help:'限制允许的最低频率，不是主动降频或锁频。生成时对齐最接近500MHz的真实频点；高于硬件最低也可能增加待机功耗。实际回落还受负载、PL和系统请求影响。'},'policy_freq',ctx),
                field({key:'scaling_max_freq',label:'最高频率',type:'freq',help:'限制本核组的最高请求范围。实际还会受到温控和其他性能约束影响。'},'policy_freq',ctx),
                h('h4',null,'WALT 调频参数'),
                h('p',{className:'cpu-help'},'点开每一项查看大白话解释、实际读回和设置控件。未配置与 0 的含义不同；不支持的参数不会假装已生效。'),
                dev?M.specs.map(function(spec){return field(spec,'policy_walt',ctx);}):h('p',null,'未发现可配置的 CPU 策略。')
            ]);
        }

        /* 说明：区域标题里带该区频率范围，便于对照三个区的实际跨度。 */
        function zoneRange(zn){
            var d=hardware.find(function(x){return x.id===policy;});
            if(!d||!bounds||!bounds.clusters||!bounds.clusters[policy])return '';
            var lo=Number(d.values.cpuinfo_min_freq)||0, hi=Number(d.values.cpuinfo_max_freq)||0;
            var cb=bounds.clusters[policy];
            var linear=Math.min(Math.max(Number(cb.linear_end),lo),hi);
            var decay=Math.min(Math.max(Number(cb.decay_end),linear),hi);
            var span=zn.key==='linear'?[lo,linear]:(zn.key==='decay'?[linear,decay]:[decay,hi]);
            if(!(span[1]>span[0]))return '';
            return (span[0]/1000).toFixed(0)+'–'+(span[1]/1000).toFixed(0)+' MHz';
        }

        function zoneSection(zn){
            var boost=M.zoneBoost(draft,mode,zn.key,policy);
            var phase=phaseMap[zn.key]||'*';
            var open=!!openMap['zone:'+mode+':'+zn.key];
            var sliderOpen=!!openMap['slider:'+mode+':'+zn.key+':'+policy];
            return h('details',{key:zn.key,className:'cpu-zone-row cpu-zone-block',
                onToggle:function(e){markOpen('zone:'+mode+':'+zn.key,e.currentTarget.open);}},[
                h('summary',null,[
                    h('span',{className:'cpu-zone-name'},zn.label),
                    h('span',{className:'cpu-zone-range'},zoneRange(zn)),
                    h('span',{className:'cpu-zone-dir'+(Number(boost.start)<=Number(boost.end)?' warm':' cool')},
                        Number(boost.start)<=Number(boost.end)?'高频率更积极':'高频率更省电')
                ]),
                open?h(React.Fragment,null,[
                    h('p',{className:'cpu-help'},zn.hint+'。守护进程按每个核组当前频率所在区域，取这一区的 boost 公式与策略下发。'),
                    h('div',{className:'cpu-zone-boost'},[
                        h('div',{className:'cpu-zone-boost-head'},'动态 boost · 策略 '+policy+(device?'（CPU '+(device.values.related_cpus||'?')+'）':'')),
                        BendEditor({
                            label:zn.label,value:boost.bend,disabled:busy,open:sliderOpen,
                            onToggle:function(next){markOpen('slider:'+mode+':'+zn.key+':'+policy,next);},
                            onChange:function(v){updateBoost(zn.key,'bend',v);}
                        }),
                        h('div',{className:'cpu-zone-edit'},[
                            h('span',{className:'cpu-zone-edit-label'},'起点'),
                            h('input',{type:'number',step:1,min:-1000,max:1000,'aria-label':zn.label+'起点',value:boost.start,disabled:busy,onChange:function(e){updateBoost(zn.key,'start',e.target.value);}}),
                            h('span',null,'→'),
                            h('span',{className:'cpu-zone-edit-label'},'终点'),
                            h('input',{type:'number',step:1,min:-1000,max:1000,'aria-label':zn.label+'终点',value:boost.end,disabled:busy,onChange:function(e){updateBoost(zn.key,'end',e.target.value);}})
                        ]),
                        h(ZoneCurvePreview,{label:zn.label,boost:boost})
                    ]),
                    h('div',{className:'cpu-phase-row',role:'tablist','aria-label':zn.label+'触摸阶段'},PHASES.map(function(ph){
                        return h('button',{key:ph.key,type:'button',role:'tab','aria-selected':phase===ph.key,title:ph.hint,
                            className:'cpu-phase-chip'+(phase===ph.key?' is-active':''),disabled:busy,
                            onClick:function(){setPhaseMap(function(prev){return prev[zn.key]===ph.key?prev:Object.assign({},prev,{[zn.key]:ph.key});});}},ph.label);
                    })),
                    h('p',{className:'cpu-help'},(PHASES.filter(function(x){return x.key===phase;})[0]||PHASES[0]).hint),
                    paramList({mode:mode,zone:zn.key,phase:phase,policy:policy})
                ]):null
            ]);
        }

        return h('section',{className:'cpu-config'},[
            h('h1',null,'CPU 与 WALT 配置'),
            h('p',{className:'cpu-help'},'直接编辑后端 cpu_policy.json。浏览和调整草稿不会写硬件；保存后由运行中的守护进程按当前模式热加载。'),
            h('div',{className:'cpu-actions'},[h('button',{type:'button',disabled:busy,onClick:function(){load(true);}},'重新读取配置'),h('button',{type:'button',disabled:busy,onClick:refreshHardware},'刷新设备频率'),h('button',{type:'button',disabled:busy,onClick:regenerate},'按作者经验重新生成')]),
            error?h('p',{role:'alert',className:'cpu-error'},error):null,
            hardwareError?h('p',{role:'alert',className:'cpu-warn'},hardwareError+'；不会用猜测频率替代。'):null,
            !draft?h('p',{role:'status'},busy?'读取配置…':'尚未读取到配置，请重试。'):h(React.Fragment,null,[

                /* ── 开头：三个能效区域的边界（全局一份，物理分段） ── */
                h('h2',null,'能效区域'),
                h('p',{className:'cpu-help'},'把每个核组的频率范围切成三段：线性区（频率与收益近似成正比）、收益递减区（频率继续提升但收益放缓）、饱和区（频率很高、收益趋平）。四个模式各自拥有这三段的配置，边界在这里统一定义。'),
                /* 说明：v2.5.10：采样间隔是公用设置（区域判定 / 动态限最大频 / boost / 频率展示共用），
                 * 从「写入动态 boost」里提出来单独成项，不再受 boost 开关影响。 */
                h('div',{className:'cpu-setting'},[
                    h('label',null,['采样间隔（毫秒）',h('input',{type:'number',min:10,max:10000,step:1,'aria-label':'采样间隔',value:(bounds&&bounds.sample_ms)||10,disabled:busy,onChange:function(e){updateBounds({sample_ms:e.target.value===''?10:Number(e.target.value)});}})]),
                    h('p',{className:'cpu-help'},'公用间隔：区域判定、动态限最大频、动态 boost 写入和状态页的频率显示都用它。主循环本身约 80ms 一轮，所以小于 80ms 在常态下等同于「每轮都采样」，只在连续触摸把循环打快时才真正限频；调大可以省 CPU，代价是跟得慢。')
                ]),
                h('div',{className:'cpu-setting'},[
                    h('label',null,['写入动态 boost',h('select',{'aria-label':'写入动态 boost',disabled:busy,value:bounds&&bounds.enabled?'1':'0',onChange:function(e){updateBounds({enabled:e.target.value==='1'});}},[h('option',{value:'0'},'关闭（只按区域下发策略，不写 boost）'),h('option',{value:'1'},'开启（按区域公式实时写 boost）')])]),
                    bounds&&bounds.enabled?idsAll.map(function(id){
                        var cb=M.clusterBounds(draft,id);
                        var d=hardware.find(function(x){return x.id===id;});
                        var key='bounds:'+id, open=!!openMap[key];
                        var lo=d?Number(d.values.cpuinfo_min_freq):0, hi=d?Number(d.values.cpuinfo_max_freq):0;
                        return h('details',{key:id,className:'cpu-setting',onToggle:function(e){markOpen(key,e.currentTarget.open);}},[
                            h('summary',null,'策略 '+id+(d?' · CPU '+(d.values.related_cpus||'?'):'')+' 区域边界'),
                            open?h(React.Fragment,null,[
                                h('p',{className:'cpu-readback'},d?('硬件范围 '+(lo/1000).toFixed(0)+' ~ '+(hi/1000).toFixed(0)+' MHz'):'设备未发现'),
                                h('label',null,['线性区上界（kHz）',h('input',{type:'number',min:1,step:1,'aria-label':'线性区上界',value:cb.linear_end,disabled:busy,onChange:function(e){updateClusterBounds(id,{linear_end:e.target.value===''?0:Number(e.target.value)});}})]),
                                h('label',null,['收益递减区上界（kHz）',h('input',{type:'number',min:1,step:1,'aria-label':'收益递减区上界',value:cb.decay_end,disabled:busy,onChange:function(e){updateClusterBounds(id,{decay_end:e.target.value===''?0:Number(e.target.value)});}})]),
                                h('p',{className:'cpu-help'},'线性区 '+(lo/1000).toFixed(0)+'–'+(Number(cb.linear_end)/1000).toFixed(0)+' MHz · 递减区 '+(Number(cb.linear_end)/1000).toFixed(0)+'–'+(Number(cb.decay_end)/1000).toFixed(0)+' MHz · 饱和区 '+(Number(cb.decay_end)/1000).toFixed(0)+'–'+(hi/1000).toFixed(0)+' MHz')
                            ]):null
                        ]);
                    }):null
                ]),

                /* 说明：v2.5.8 动态限最大频 —— 与两条分界线绑定的档位限频。
                 * v2.5.11：这里只放总开关，两个「顶住时长」按模式配置（见各模式的卡片）。 */
                h('div',{className:'cpu-maxfreq'},[
                    h('h4',null,'动态限最大频'),
                    h('p',{className:'cpu-help'},'用上面两条分界线当档位上限：默认把每个核组压在「线性区上界」，持续顶住这个上限够久才解锁到「递减区上界」，再够久才放开到最高频率。开启后「最高频率」不再写入——固定限频让位给这套动态限频。'),
                    h('label',null,['启用动态限最大频',h('select',{'aria-label':'启用动态限最大频',disabled:busy,value:maxfreqOn?'1':'0',onChange:function(e){updateMaxfreqEnabled(e.target.value==='1');}},[h('option',{value:'1'},'开启（动态上限）'),h('option',{value:'0'},'关闭（按「最高频率」固定限）')])]),
                    h('p',{className:'cpu-help'},maxfreqOn?'两个「顶住时长」在下面各模式里单独设置——省电档该钝、极速档该快。':'关闭后按各模式的「最高频率」固定限，和 2.5.7 及以前一致。')
                ]),

                /* ── 四个模式 ── */
                h('h2',null,'模式配置'),
                h('div',{className:'cpu-mode-row',role:'tablist','aria-label':'运行模式'},M.MODE_LIST.map(function(m){
                    return h('button',{key:m,type:'button',role:'tab','aria-selected':mode===m,className:'cpu-mode-chip'+(mode===m?' is-active':''),disabled:busy,onClick:function(){setMode(m);}},M.MODE_LABELS[m]);
                })),
                h('div',{className:'cpu-selectors'},[
                    h('label',null,['CPU 核组',h('select',{'aria-label':'CPU 核组',disabled:busy,value:policy,onChange:function(e){setPolicy(e.target.value);}},idsAll.map(function(id){var d=hardware.find(function(x){return x.id===id;});return h('option',{key:id,value:id},'策略 '+id+(d?' · CPU '+(d.values.related_cpus||'?'):' · 设备未发现'));}))])
                ]),

                /* 说明：每个模式开头是它自己的触摸时序。 */
                (function(){
                    var touch=M.modeTouch(draft,mode);
                    return h('div',{className:'cpu-touch-block'},[
                        h('h3',null,M.MODE_LABELS[mode]+'模式 · 触摸时序'),
                        touch?h(React.Fragment,null,[
                            h('div',{className:'cpu-touch-fields'},[
                                h('label',null,['长触摸阈值（毫秒）',h('input',{type:'number',min:100,max:5000,step:1,'aria-label':'长触摸阈值',value:touch.long_press_ms,disabled:busy,onChange:function(e){updateTouch('long_press_ms',e.target.value);}})]),
                                h('label',null,['松手过渡（毫秒）',h('input',{type:'number',min:0,max:2000,step:1,'aria-label':'松手过渡时间',value:touch.release_delay_ms,disabled:busy,onChange:function(e){updateTouch('release_delay_ms',e.target.value);}})])
                            ]),
                            h('p',{className:'cpu-help'},'连续按住超过阈值进入长触摸；松手后按过渡时间保持，再回到常规基础。计时只在本模式生效，保存后下发。')
                        ]):h('p',{className:'cpu-warn'},'本模式缺少触摸时序，请按作者经验重新生成。')
                    ]);
                })(),

                /* 说明：v2.5.11：动态限最大频的两个「顶住时长」按模式配置。 */
                maxfreqOn?h('div',{className:'cpu-touch-block'},[
                    h('h3',null,M.MODE_LABELS[mode]+'模式 · 动态限最大频'),
                    h('div',{className:'cpu-touch-fields'},[
                        h('label',null,['顶住多久解锁到递减区上界（毫秒）',h('input',{type:'number',min:20,max:5000,step:10,'aria-label':'解锁到递减区上界的时长',value:modeMaxfreq.decay_hold_ms,disabled:busy,onChange:function(e){updateModeMaxfreq({decay_hold_ms:e.target.value===''?M.MAXFREQ_DEFAULT.decay_hold_ms:Number(e.target.value)});}})]),
                        h('label',null,['顶住多久解锁到最高频率（毫秒）',h('input',{type:'number',min:20,max:5000,step:10,'aria-label':'解锁到最高频率的时长',value:modeMaxfreq.saturate_hold_ms,disabled:busy,onChange:function(e){updateModeMaxfreq({saturate_hold_ms:e.target.value===''?M.MAXFREQ_DEFAULT.saturate_hold_ms:Number(e.target.value)});}})])
                    ]),
                    h('p',{className:'cpu-help'},'线性区没有上一档，所以只有这两个时长。时长短更容易冲上高频，时长长更省电；短于这个时间的毛刺不会解锁。回落到上一档上限的 90% 以下并持续半秒才会降回来。')
                ]):null,

                /* 说明：所选核组在该模式下的三区合并曲线，先看全貌再逐区调。 */
                (function(){
                    var d=hardware.find(function(x){return x.id===policy;});
                    if(!d)return h('p',{className:'cpu-help'},'未取得该核组频率范围，无法绘图。');
                    var cz=M.clusterZoneView(draft,mode,policy);
                    return h('div',null,[
                        h('h3',null,M.MODE_LABELS[mode]+'模式 · 策略 '+policy+' 的完整 boost 曲线'),
                        h(ZoneOverviewChart,{label:M.MODE_LABELS[mode]+'策略'+policy,cluster:cz,minFreq:Number(d.values.cpuinfo_min_freq),maxFreq:Number(d.values.cpuinfo_max_freq)})
                    ]);
                })(),

                /* 说明：三个区域，每区一套 boost 与该区自己的触摸阶段配置。 */
                h('h3',null,M.MODE_LABELS[mode]+'模式 · 三个区域'),
                M.ZONE_NAMES.map(zoneSection),

                /* 说明：通用基线（defaults）保留可编辑，但不再是主要入口。 */
                h('details',{className:'cpu-setting',onToggle:function(e){setGeneralOpen(e.currentTarget.open);}},[
                    h('summary',null,'通用基础（所有模式共用基线）'),
                    generalOpen?h(React.Fragment,null,[
                        h('p',{className:'cpu-help'},'通用基础先应用，再由各模式各区域覆盖。清空只移除此项，不代表内核恢复出厂值。'),
                        paramList({mode:'defaults',zone:'linear',phase:'*',policy:policy})
                    ]):null
                ]),

                /* 说明：整份配置的缩进格式化很贵，只在用户真正展开时才生成。 */
                h('details',{className:'cpu-setting',onToggle:function(e){setDraftOpen(e.currentTarget.open);}},[h('summary',null,'查看当前完整配置草稿'),draftOpen?h('pre',null,JSON.stringify(draft,null,2)):null]),
                h('div',{className:'cpu-save'},[h('strong',null,dirty?'有未保存的调整':'配置草稿与保存内容一致'),h('button',{type:'button',disabled:busy||!dirty,onClick:submit},busy?'处理中…':'保存 CPU 配置')])
            ]),
            message?h('p',{role:'status',className:'cpu-help'},message):null
        ]);
    }
    CP.ConfigPage=ConfigPage;
})(window.CP = window.CP || {});