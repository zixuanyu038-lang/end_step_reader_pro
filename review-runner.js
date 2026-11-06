'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),P=require('./studio-protocol'),S=require('./studio-schema');
async function runReview({job,replay,ask,progress,cacheDir}){
  const games=[...new Set(replay.model.turns.map(t=>t.game))],finished=new Map(),stages=new Map(games.map(game=>[game,{game,status:'waiting',message:'等待分析'}]));let revision=0;
  await fs.mkdir(cacheDir,{recursive:true});
  function publish(){
    const results=[...finished.values()].sort((a,b)=>a.games[0].game-b.games[0].game);
    job.result={...job.result,reviewRevision:finished.size,gameStages:[...stages.values()],reviewPending:true};
    if(results.length)job.result.review={summary:`已完成 ${results.length} / ${games.length} 局复盘。`,overallPlan:'已完成的分局结果可以先阅读；整盘结论将在全部复核后汇总。',games:results.flatMap(r=>r.games),hiddenHands:results.flatMap(r=>r.hiddenHands),takeaways:[...new Set(results.flatMap(r=>r.takeaways))]};
  }
  function stage(game,status,message){stages.set(game,{game,status,message});publish();progress(job,'review',`第 ${game} 局：${message}`);}
  async function one(game){
    const cache=path.join(cacheDir,replay.id+'.game-'+game+'.v3.json');let data;
    if(!job.forceReview)try{data=P.validateReview(JSON.parse(await fs.readFile(cache,'utf8')),replay.model,{games:[game]});finished.set(game,data);stage(game,'complete','已读取通过复核的分局结果');return data;}catch{}
    stage(game,'analyzing','正在分析关键决策、法术力与可能的隐藏手牌');
    data=await ask(job,P.reviewPrompt(replay.model,game),S.review);let auditLines=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        P.validateReview(data,replay.model,{games:[game]});stage(game,'checking','正在复核费用与具体新打法');
        const subset=auditLines?{...data,games:data.games.map(g=>({...g,findings:g.findings.filter(f=>auditLines.includes(f.sourceLine))}))}:data;
        const audit=await ask(job,P.reviewAuditPrompt(replay.model,subset),S.verification);S.validate(audit,S.verification);
        if(!audit.accepted||audit.issues.length)throw Object.assign(Error(audit.issues.map(i=>'节点 '+i.step+'：'+i.message).join('；')||audit.summary),{sourceLines:audit.issues.map(i=>i.step)});
        await fs.writeFile(cache,JSON.stringify(data,null,2));finished.set(game,data);stage(game,'complete','费用与路线复核完成');return data;
      }catch(error){
        if(job.abort.signal.aborted)throw error;
        await fs.writeFile(path.join(job.dir,`review-game-${game}-attempt-${attempt+1}.json`),JSON.stringify({review:data,error:error.message,sourceLines:error.sourceLines||[]},null,2));
        if(attempt===2){stage(game,'failed',error.message);throw error;}
        const ids=[...new Set(error.sourceLines||[])],existing=data.games.flatMap(g=>g.findings).map(f=>f.sourceLine);
        if(ids.length&&ids.every(id=>existing.includes(id))){
          stage(game,'repairing','仅修正未通过的节点：'+ids.join('、')+'；'+error.message);
          const patch=await ask(job,P.reviewRepairPrompt(replay.model,data,ids,error.message),S.reviewPatch);S.validate(patch,S.reviewPatch);
          if(patch.replacements.length!==ids.length||new Set(patch.replacements.map(p=>p.originalSourceLine)).size!==ids.length||patch.replacements.some(p=>!ids.includes(p.originalSourceLine)))throw Error('节点修正没有精确覆盖失败项。');
          const replacements=new Map(patch.replacements.map(p=>[p.originalSourceLine,p.finding]));data={...data,games:data.games.map(g=>({...g,findings:g.findings.map(f=>replacements.get(f.sourceLine)||f)}))};auditLines=patch.replacements.map(p=>p.finding.sourceLine);
        }else{
          stage(game,'repairing','正在修正本局结构或引用：'+error.message);
          data=await ask(job,P.reviewPrompt(replay.model,game)+'\n上次本局结果未通过：'+error.message+'\n请修正本局，其他对局不在本次范围内。',S.review);auditLines=null;
        }
      }
    }
  }
  // Requests share the server's bounded Codex queue. Completed games are visible immediately.
  const outcomes=await Promise.allSettled(games.map(async game=>{try{return await one(game);}catch(e){stage(game,'failed',e.message);throw e;}}));
  const failure=outcomes.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  const parts=outcomes.map(r=>r.value);let overview;
  if(parts.length===1)overview={summary:parts[0].summary,overallPlan:parts[0].overallPlan,takeaways:parts[0].takeaways};
  else{
    progress(job,'review_summary','各局复核完成，正在汇总整盘结论…');
    overview=await ask(job,'根据已经复核的分局结论汇总整盘评价、总体计划和要点，不新增未经验证的具体动作或隐藏牌事实。只返回 summary、overallPlan、takeaways。\n'+JSON.stringify(parts.map(r=>({summary:r.summary,overallPlan:r.overallPlan,games:r.games.map(g=>({game:g.game,summary:g.summary,findings:g.findings.map(f=>({title:f.title,analysis:f.analysis,recommended:f.recommended}))})),takeaways:r.takeaways}))),S.overview);S.validate(overview,S.overview);
  }
  const result={...overview,games:parts.flatMap(r=>r.games).sort((a,b)=>a.game-b.game),hiddenHands:parts.flatMap(r=>r.hiddenHands)};P.validateReview(result,replay.model);replay.review=result;await fs.writeFile(path.join(cacheDir,replay.id+'.json'),JSON.stringify(result,null,2));return result;
}
module.exports={runReview};
