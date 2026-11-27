# 说明：结合作者经验与给定 WALT 源码的纯生成规则；只转换发现协议，不写设备或文件。
BEGIN {
    FS="\t"; CONVFMT="%.17g"; OFMT="%.17g"
    daily_cap=2100000; save_cap=1500000; performance_cap=2600000
    anchor_low=500000; anchor_mid=1000000; anchor_high=1500000
    max_policies=32; max_frequencies=512; max_text=127
    mode[1]="powersave";mode[2]="balance";mode[3]="performance";mode[4]="fast"
    # 说明：v2.5.11：动态限最大频的「顶住时长」按模式各自配置（毫秒）。
    # 省电最钝（很难冲上高频）、均衡居中、性能/极速越来越快。
    # 均衡按用户要求 800/1600，其余按档位递进取值。
    hold_decay[1]=1600; hold_sat[1]=3200
    hold_decay[2]=800;  hold_sat[2]=1600
    hold_decay[3]=400;  hold_sat[3]=800
    hold_decay[4]=200;  hold_sat[4]=400
    # 说明：时间为可调产品默认；1ms限制重复升频，降频0不人为延长高频驻留。
    rise_delay=1000; fall_delay=0; disable_hispeed_condition=2147483647
    walt_count=split("pl target_loads zone_max_util_pct up_rate_limit_us down_rate_limit_us hispeed_load hispeed_freq hispeed_cond_freq rtg_boost_freq adaptive_level_1 adaptive_low_freq adaptive_high_freq",walt_keys," ")
    walt_default["pl"]=1
    walt_default["up_rate_limit_us"]=rise_delay;walt_default["down_rate_limit_us"]=fall_delay
    # 说明：只清hispeed_freq不能关闭新任务满需求支路，条件门槛同时阻断该分支。
    walt_default["hispeed_load"]=100;walt_default["hispeed_freq"]=0
    walt_default["hispeed_cond_freq"]=disable_hispeed_condition;walt_default["rtg_boost_freq"]=0
    # 说明：本源码以用户态high非0作为整段入口；三项清零，不给其他内核伪造内核态重置能力。
    walt_default["adaptive_level_1"]=0;walt_default["adaptive_low_freq"]=0;walt_default["adaptive_high_freq"]=0
}
function error(message) { print "作者默认生成失败：" message > "/dev/stderr"; bad=1; exit 1 }
function number(value) { return value ~ /^[0-9]+$/ && value+0>0 && value+0<=2147483647 }
function min(a,b) { return a<b?a:b }
function max(a,b) { return a>b?a:b }
function add_frequency(id,value, key) {
    if(!number(value))return
    key=id SUBSEP (value+0)
    if(key in known)return
    if(count[id]>=max_frequencies)error("CPU 频点数量超限")
    known[key]=1;freq[id,++count[id]]=value+0
}
function nearest(id,target, j,best,difference,next_difference) {
    best=freq[id,1];difference=best>target?best-target:target-best
    for(j=2;j<=count[id];j++) {
        next_difference=freq[id,j]>target?freq[id,j]-target:target-freq[id,j]
        if(next_difference<difference) { best=freq[id,j];difference=next_difference }
    }
    return best
}
function ceiling_for(id,target, j,result) {
    result=freq[id,1]
    for(j=1;j<=count[id];j++)if(freq[id,j]<=target)result=freq[id,j]
    return result
}
function supports(id,key) { return values[id,"scaling_governor"]=="walt" && support[id,key] }
function walt_object(id, j,key,result,value) {
    result=""
    for(j=1;j<=walt_count;j++) {
        key=walt_keys[j]
        if(!supports(id,key))continue
        if(key=="target_loads")value="\"0\""
        else if(key=="zone_max_util_pct")value="\"2147483647 100\""
        else value=sprintf("%.0f",walt_default[key])
        result=result (result==""?"":",") "\""key"\":"value
    }
    return result
}
# 说明：完整三台阶设为同一低档，避免低中需求被推至另一个高档；缺项时用有限期频率下限。
function touch_json(mode_no,phase,cap, j,id,target,floor,base,high,adaptive,walt,freq,text,rate) {
    target=phase==1?(mode_no==1?850000:(mode_no==2?1000000:(mode_no==3?1200000:1500000))):(mode_no==1?650000:(mode_no==2?800000:(mode_no==3?1000000:1200000)))
    rate=phase==1?8000:(phase==2?4000:12000)
    walt="";freq=""
    for(j=1;j<=policies;j++) {
        id=ids[j];high=cap?ceiling_for(id,cap):maximum[id]
        base=min(high,nearest(id,anchor_low));floor=max(base,min(high,nearest(id,target)))
        adaptive=supports(id,"adaptive_level_1") && supports(id,"adaptive_low_freq") && supports(id,"adaptive_high_freq")
        text=""
        if(adaptive)text="\"adaptive_level_1\":"floor",\"adaptive_low_freq\":"floor",\"adaptive_high_freq\":"floor
        else freq=freq (freq==""?"":",") "\""id"\":{\"scaling_min_freq\":"floor"}"
        if(supports(id,"down_rate_limit_us"))text=text (text==""?"":",") "\"down_rate_limit_us\":"rate
        if(text!="")walt=walt (walt==""?"":",") "\""id"\":{"text"}"
    }
    return "{" (freq!=""?"\"policy_freq\":{"freq"}":"") (freq!=""&&walt!=""?",":"") (walt!=""?"\"policy_walt\":{"walt"}":"") "}"
}
function frequencies_json( j,id,text) {
    text="{" 
    for(j=1;j<=policies;j++) {
        id=ids[j]
        text=text (j==1?"":",") "\""id"\":{\"scaling_min_freq\":"sprintf("%.0f",minimum[id])",\"scaling_max_freq\":"sprintf("%.0f",maximum[id])"}"
    }
    return text "}"
}
# 说明：v2.5.5：global.zones 只描述三个区域的边界（物理分段，全局一份）；
# 每区的 boost 公式移到 presets[模式].zones[区域].boost。按 min/max 三等分划三区。
function zones_json( j,id,lo,hi,third,text) {
    # 说明：v2.5.10：采样间隔回到 10ms。它是公用间隔（区域判定 / 动态限最大频 /
    # boost / 频率展示共用），不再是 boost 专属；主循环本身约 80ms 一轮，
    # 所以 10ms 在常态下等价于「每轮都采样」，只在连续触摸把循环打快时才真正限频。
    text="{\"enabled\":true,\"sample_ms\":10,\"clusters\":{"
    for(j=1;j<=policies;j++) {
        id=ids[j];lo=minimum[id];hi=maximum[id];third=int((hi-lo)/3)
        # 说明：v2.5.11：分界线对齐到该核组真实存在的频点。动态限最大频直接拿分界线当上限
        # 写 scaling_max_freq；写一个表里没有的频率会被内核向下取整
        # （真机日志里 97% 的写入因此读回更低），对齐之后写入即生效。
        le=nearest(id,lo+third);de=nearest(id,lo+third*2)
        if(le<lo)le=lo
        if(de<=le)de=le
        text=text (j==1?"":",") "\""id"\":{\"linear_end\":"le",\"decay_end\":"de"}"
    }
    return text "}}"
}
# 说明：每区一套 boost 公式（作者经验值）：线性 -15（-5→-18）、递减 -30（-18→-40）、
# 饱和 0（-40→-90）。探测到该核组 boost 不支持负数时把起止值归零，避免被内核拒绝。
function zone_boost_json(zone, j,id,neg,text) {
    text="{"
    for(j=1;j<=policies;j++) {
        id=ids[j];neg=(id in neg_support)?neg_support[id]:1
        text=text (j==1?"":",") "\""id"\":{"
        if(!neg) text=text "\"bend\":"(zone==1?-15:(zone==2?-30:0)) ",\"start\":0,\"end\":0"
        else if(zone==1) text=text "\"bend\":-15,\"start\":-5,\"end\":-18"
        else if(zone==2) text=text "\"bend\":-30,\"start\":-18,\"end\":-40"
        else text=text "\"bend\":0,\"start\":-40,\"end\":-90"
        text=text "}"
    }
    return text "}"
}
$0=="" { next }
$1=="NEG" { neg_support[$2]=$3; next }
$1=="POLICY" {
    id=$2
    if(NF!=2 || id!~/^(0|[1-9][0-9]*)$/ || length(id)>5 || present[id] || ended)error("策略编号或顺序无效")
    if(++policies>max_policies)error("核组数量超限")
    present[id]=1;ids[policies]=id;next
}
$1=="VALUE" {
    if(NF!=4 || !present[$2] || ended)error("设备范围记录不完整")
    gsub(/^[ \r]+|[ \r]+$/,"",$4);values[$2,$3]=$4;next
}
$1=="FREQ" {
    if(NF<3 || !present[$2] || ended)error("频点记录不完整")
    n=split($4,list,/[ \r]+/);for(i=1;i<=n;i++)add_frequency($2,list[i]);next
}
$1=="WALT" {
    if(NF!=4 || !present[$2] || ended)error("WALT 记录不完整")
    gsub(/^[ \r]+|[ \r]+$/,"",$4)
    if($4!="" && $4!="missing" && $4!="unreadable")support[$2,$3]=1
    next
}
$1=="END" { if($2!="1" || ended)error("结束记录无效");ended=1;next }
{ error("未知设备记录") }
END {
    if(bad)exit 1
    if(!ended || !policies)error("设备信息不完整")
    if(log_level!~/^[0123]$/)error("日志级别无效")
    ids_pattern="";walt_pattern="";walt_json=""
    for(i=1;i<=policies;i++) {
        id=ids[i];low=values[id,"cpuinfo_min_freq"];high=values[id,"cpuinfo_max_freq"]
        if(number(low) && number(high) && low+0<=high+0) {
            low+=0;high+=0
            kept=0
            for(j=1;j<=count[id];j++)if(freq[id,j]>=low && freq[id,j]<=high)freq[id,++kept]=freq[id,j]
            count[id]=kept;add_frequency(id,low);add_frequency(id,high)
        }
        if(!count[id])error("策略 "id" 没有可靠的频率范围")
        for(j=2;j<=count[id];j++) { value=freq[id,j];k=j-1;while(k>=1 && freq[id,k]>value) { freq[id,k+1]=freq[id,k];k-- };freq[id,k+1]=value }
        minimum[id]=freq[id,1];maximum[id]=freq[id,count[id]]
        ids_pattern=ids_pattern (i==1?"":"|") id
        entry=walt_object(id)
        if(entry!="") {
            walt_pattern=walt_pattern (walt_pattern==""?"":"|") id
            walt_json=walt_json (walt_json==""?"":",") "\""id"\":{"entry"}"
        }
    }
    props=""
    for(i=1;i<=walt_count;i++)props=props (i==1?"":"|") walt_keys[i]
    # 说明：v2.5.8：动态限最大频默认开启（200ms/400ms 分档解锁），
    # 打开后策略树不再写 scaling_max_freq，由运行时限频器按两条分界线压上限。
    # 说明：v2.5.11：global 只留总开关，两个时长改到各模式里。
    maxfreq_json="\"maxfreq\":{\"enabled\":true}"
    output="{\"version\":\"author-touch-3\",\"global\":{\"log_level\":"log_level",\"zones\":"zones_json()","maxfreq_json"},\"sysfs\":[{\"name\":\"policy_freq\",\"path\":\"/sys/devices/system/cpu/cpufreq/policy{policy}/{prop}\",\"params\":{\"policy\":\""ids_pattern"\",\"prop\":\"scaling_max_freq|scaling_min_freq\"}}"
    if(walt_json!="")output=output ",{\"name\":\"policy_walt\",\"path\":\"/sys/devices/system/cpu/cpufreq/policy{policy}/walt/{prop}\",\"params\":{\"policy\":\""walt_pattern"\",\"prop\":\""props"\"}}"
    output=output "],\"defaults\":{\"policy_freq\":"frequencies_json()
    if(walt_json!="")output=output ",\"policy_walt\":{"walt_json"}"
    output=output "},\"presets\":{"
    # 说明：v2.5.5：每档 = 触摸时序 + 三个区域；每个区域各带一套 boost 与基本/触摸配置。
    # 默认三区的策略数值相同（沿用作者经验值），差异只在 boost 公式；
    # 逐区差异化是留给用户调参的，生成器不替他编数值。
    for(i=1;i<=4;i++) {
        cap=i==1?save_cap:(i==2?daily_cap:(i==3?performance_cap:0))
        zones_text=""
        for(z=1;z<=3;z++) {
            zname=(z==1?"linear":(z==2?"decay":"saturate"))
            zones_text=zones_text (z==1?"":",") "\"" zname "\":{\"boost\":" zone_boost_json(z) ",\"*\":{\"policy_freq\":" frequencies_json() "},\"touch_down\":" touch_json(i,1,cap) ",\"touch_long\":" touch_json(i,2,cap) ",\"touch_up\":" touch_json(i,3,cap) "}"
        }
        mode_mf="\"maxfreq\":{\"decay_hold_ms\":"hold_decay[i]",\"saturate_hold_ms\":"hold_sat[i]"}"
        output=output (i==1?"":",") "\""mode[i]"\":{\"touch\":{\"long_press_ms\":500,\"release_delay_ms\":180},"mode_mf",\"zones\":{"zones_text"}}"
    }
    output=output "}}"
    if(length(output)>131072)error("生成配置超过128KB")
    print output
}