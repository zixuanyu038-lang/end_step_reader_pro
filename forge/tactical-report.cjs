'use strict';
const fs=require('node:fs');

const sampleKey=s=>s.line+':'+s.world;
const routeKey=route=>JSON.stringify(route.map(a=>a.key));
function armFingerprint(arm){
  return {native:arm.native,worst:arm.worst,partial:arm.partial,errors:[...arm.errors].sort(),
    forks:arm.forks.map(fork=>({
      path:routeKey(fork.path),turn:fork.turn,phase:fork.phase,gaps:[...fork.gaps].sort(),
      replies:fork.replies.map(reply=>({
        action:reply.action.key,outcome:reply.outcome,best:reply.best,error:reply.error,
        routeProbe:reply.routeProbe&&{result:reply.routeProbe.result,interrupted:reply.routeProbe.interrupted},
        recoveries:reply.recoveries.map(r=>({action:r.action.key,result:r.result,error:r.error}))
          .sort((a,b)=>a.action.localeCompare(b.action))
      })).sort((a,b)=>a.action.localeCompare(b.action))
    })).sort((a,b)=>a.path.localeCompare(b.path))};
}

function counts(pairs){
  const result={sampled:pairs.length,compared:0,flips:0,reverse:0,baseWins:0,altWins:0,faster:0,slower:0};
  for(const [base,alt] of pairs){
    if(!base||!alt)continue;
    result.compared++;
    if(base.value===1)result.baseWins++;
    if(alt.value===1)result.altWins++;
    if(base.value===-1&&alt.value===1)result.flips++;
    if(base.value===1&&alt.value===-1)result.reverse++;
    if(base.value===1&&alt.value===1&&alt.turn<base.turn)result.faster++;
    if(base.value===1&&alt.value===1&&alt.turn>base.turn)result.slower++;
  }
  return result;
}
function panel(samples){
  const native=counts(samples.map(s=>[s.baseline.native,s.alternative.native]));
  const tested=samples.filter(s=>s.baseline.forks.length||s.alternative.forks.length);
  const challenged=counts(tested.map(s=>[s.baseline,s.alternative].map(a=>a.partial?null:a.worst||a.native)));
  const counters=samples.flatMap(s=>s.alternative.native?.value===1?s.alternative.forks.flatMap(f=>f.replies.flatMap(r=>
    r.best&&r.best.value<1?[{world:s.world,turn:f.turn,phase:f.phase,action:r.action.label,result:r.best}]:[])):[]);
  const replies=samples.reduce((n,s)=>n+[s.baseline,s.alternative].reduce((m,a)=>m+a.forks.reduce((k,f)=>k+f.replies.length,0),0),0);
  return {native,challenged,counters,replies};
}

function tacticalReport(first,repeat){
  const other=new Map(repeat.map(s=>[sampleKey(s),s])),mismatches=[];
  for(const sample of first){
    const key=sampleKey(sample),matched=other.get(key);
    if(!matched){mismatches.push({key,reason:'missing in repeat'});continue;}
    other.delete(key);
    for(const arm of ['baseline','alternative'])
      if(JSON.stringify(armFingerprint(sample[arm]))!==JSON.stringify(armFingerprint(matched[arm])))
        mismatches.push({key,arm,reason:'engine decision or outcome differed'});
  }
  for(const key of other.keys())mismatches.push({key,reason:'unexpected sample in repeat'});
  const lines=[...new Set(first.map(s=>s.line))].map(line=>{
    const samples=first.filter(s=>s.line===line);
    return {line,scope:samples[0].scope,discovery:panel(samples.filter(s=>!s.holdout)),holdout:panel(samples.filter(s=>s.holdout))};
  });
  return {first:first.length,repeat:repeat.length,mismatches,lines};
}

function challengedPath(arm,originalPath){
  if(arm.partial)return null;
  if(!arm.worst)return arm.native?{outcome:arm.native,path:originalPath}:null;
  const same=(a,b)=>a?.value===b.value&&a?.turn===b.turn;
  for(const fork of arm.forks)for(const reply of fork.replies){
    if(!same(reply.best,arm.worst))continue;
    const path=fork.path.concat(reply.action);
    if(same(reply.outcome,reply.best))return {outcome:reply.best,path};
    if(reply.routeProbe?.bestPath&&same(reply.routeProbe.result,reply.best))
      return {outcome:reply.best,path:reply.routeProbe.bestPath};
    const recovery=reply.recoveries.find(r=>same(r.result,reply.best));
    if(recovery)return {outcome:reply.best,path:path.concat(recovery.action)};
  }
  return null;
}

function tacticalExportPlan(plans,samples,report){
  const rejected=new Set(report.mismatches.map(row=>row.key));
  const candidates=[];
  for(const sample of samples){
    if(!sample.holdout||rejected.has(sampleKey(sample))||!sample.alternative.forks.length)continue;
    const plan=plans.find(p=>p.line===sample.line);
    const pair=plan.pairs[0];
    const baseline=challengedPath(sample.baseline,pair.baselinePath.slice(0,1));
    const alternative=challengedPath(sample.alternative,pair.alternatePath.slice(0,1));
    if(baseline?.outcome.value!==-1||alternative?.outcome.value!==1)continue;
    const {challenged,native}=report.lines.find(row=>row.line===sample.line).holdout;
    candidates.push({sample,plan,baseline,alternative,net:challenged.flips-challenged.reverse,
      nativeNet:native.flips-native.reverse});
  }
  candidates.sort((a,b)=>b.net-a.net||b.nativeNet-a.nativeNet||
    a.alternative.outcome.turn-b.alternative.outcome.turn||a.sample.line-b.sample.line);
  if(!candidates.length)return [];
  const {sample,plan,baseline,alternative}=candidates[0];
  return [{line:sample.line,holdouts:plan.holdouts,exhaustive:true,
    pairs:[{world:sample.world,baselinePath:baseline.path,alternatePath:alternative.path}],
    export:{world:sample.world,name:'复跑验收-第'+sample.line+'行-翻盘.esreplay',criterion:'flip',
      description:'首跑和复跑结果一致的一组独立暗手。回放包含所测同回合应手中的最差结果和对应补救，之后由 Forge 续打。'}}];
}

if(require.main===module){
  const [first,repeat,output,planFile,exportFile]=process.argv.slice(2);
  if(!first||!repeat||!output)throw Error('Pass the first results, reproduced results and report path.');
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
  const samples=read(first),report=tacticalReport(samples,read(repeat));
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  if(planFile&&exportFile)fs.writeFileSync(exportFile,JSON.stringify(tacticalExportPlan(read(planFile),samples,report),null,2));
  console.log(JSON.stringify({first:report.first,repeat:report.repeat,mismatches:report.mismatches.length,
    lines:report.lines.map(r=>({line:r.line,discovery:r.discovery.native,holdout:r.holdout.native,
      challenged:r.holdout.challenged,discoveryReplies:r.discovery.replies,holdoutReplies:r.holdout.replies,
      counterexamples:r.discovery.counters.length+r.holdout.counters.length}))}));
}
module.exports={tacticalReport,tacticalExportPlan};
