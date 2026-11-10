'use strict';
const {compact,inspectSearchWorlds,mapSearchWorlds,originalSelection,rankActions}=require('./tree-search');
const Schema=require('./search-schema'),{validate}=require('./studio-schema');
const {isDeepStrictEqual}=require('node:util');
const label=a=>a.kind==='pass'?'这次先不出牌':a.cardName||a.label||a.key;
function describeAction(action,state,viewer){
  const cards=state.players.flatMap(p=>['battlefield','graveyard','exile'].flatMap(zone=>p[zone]||[])
    .concat(String(p.id)===viewer?p.hand||[]:[])).concat((state.stack||[]).map(item=>item.sourceCard));
  const targets=(action.targets||[]).flat().map(ref=>{
    if(ref.startsWith('p:'))return ref.slice(2)===viewer?'我方':'对手';
    return cards.find(c=>c&&String(c.id)===ref.slice(2))?.name||null;
  }).filter(Boolean);
  const modes=action.modeDescriptions||[];
  return [label(action),targets.length?'目标 '+targets.join('、'):'',modes.length?'选择 '+modes.join(' / '):''].filter(Boolean).join(' · ');
}
const planId=(kind,action)=>kind+':'+(kind==='own'?action.key:
  JSON.stringify([action.kind,action.cardName,action.abilityIndex,action.modes,action.targets,action.x]));
const direction={win:'胜 → 负',loss:'负 → 胜'};
const settings={horizonTurns:100,maxChoices:2000,maxSteps:4000};
function gameOutcomes(model){
  const games=[...new Set(model.turns.map(t=>t.game))],seat=String(model.header.seat),results={};
  for(const game of games){
    const ends=model.turns.filter(t=>t.game===game).flatMap(t=>t.entries.filter(e=>e.type==='GAME_OUTCOME').map(e=>e.raw));
    const winners=[...new Set(ends.map(e=>String(e.playerIndex??e.winnerId??'')))];
    if(winners.length===1&&['0','1'].includes(winners[0]))results[game]=winners[0]===seat?'win':'loss';
    else if(!ends.length&&games.length===1&&model.header.complete&&['win','loss'].includes(model.header.result))results[game]=model.header.result;
  }
  return results;
}
function terminal(run,viewer){
  if(run.stopReason!=='game_over'||run.state.status!=='COMPLETE'||run.state.winnerId==null)return null;
  return {outcome:String(run.state.winnerId)===viewer?'win':'loss',turn:run.state.turnNumber};
}
function isFlip(before,after,outcome){
  return before?.outcome===outcome&&after?.outcome===(outcome==='loss'?'win':'loss');
}
async function attempt(work,signal){
  signal?.throwIfAborted();
  try{return await work();}catch(error){signal?.throwIfAborted();return null;}
}
const request=(forge,world,command,path,signal,options={})=>forge.request(
  {command,root:world.root,path:path.map(compact),...settings,...options},{signal});
function simulate(forge,world,path,signal,includeTrace=false,resolutionChoice=null,timedCast=null){
  return request(forge,world,'simulate',path,signal,{includeTrace,...(resolutionChoice?{resolutionChoice}:{}),...(timedCast?{timedCast}:{})});
}
async function opponentFork(forge,world,original,initial,viewer,signal){
  const path=[original];
  let fork=await request(forge,world,'expand',path,signal);
  if(fork.stopReason==='decision'&&String(fork.state.priorityPlayerId)===viewer){
    const pass=fork.actions.find(a=>a.kind==='pass');
    if(!pass)return null;
    path.push(pass);fork=await request(forge,world,'expand',path,signal);
  }
  if(fork.stopReason!=='decision'||String(fork.state.priorityPlayerId)!==String(1-Number(viewer))||
    Number(fork.state.turnNumber)!==Number(initial.state.turnNumber)||fork.state.phase!==initial.state.phase)return null;
  return {path,fork};
}
async function makeContext({record,world,initial,worker,signal}){
  const viewer=String(record.source.header.seat),original=originalSelection(record.source,initial.actions);
  if(!original.matched||String(original.action.actorId)!==viewer)return null;
  const path=[original.action],run=await simulate(worker,world,path,signal),baseline=terminal(run,viewer);
  if(!baseline)return null;
  const own=rankActions(initial.actions,initial.state,{width:9}).filter(a=>a.key!==original.key);
  // Include additional actions that reached the sought terminal result in the existing search.
  const wanted=record.node.outcome==='win'?String(1-Number(viewer)):viewer;
  const searched=record.result.runs?.find(w=>w.worldId===world.id)?.simulations||[];
  const firstKeys=new Set(searched.filter(s=>s.terminal&&String(s.winnerId)===wanted).map(s=>s.path[0]?.key));
  for(const a of initial.actions)if(firstKeys.has(a.key)&&a.key!==original.key&&!own.some(o=>o.key===a.key))own.push(a);
  let reply=null;
  if(record.node.outcome==='win')
    reply=await attempt(()=>opponentFork(worker,world,original.action,initial,viewer,signal),signal);
  return {viewer,original:original.action,originalText:describeAction(original.action,initial.state,viewer),baseline,own:own.slice(0,12),reply,world,initial};
}
function choicePlans(choice){
  const {options,picked,name}=choice;
  const ids=items=>items.map(c=>c.id).sort((a,b)=>a-b);
  const baseline=picked.slice().sort((a,b)=>a-b).join(',');
  const optionsSets=name==='Stock Up'?options.flatMap((a,i)=>options.slice(i+1).map(b=>[a,b])):options.map(c=>[c]);
  return optionsSets.filter(cards=>ids(cards).join(',')!==baseline).map(cards=>({
    id:'choice:'+ids(cards).join(','),kind:'choice',ids:ids(cards),    label:(name==='Stock Up'?'拿 ':'放下 ')+cards.map(c=>c.name).join(' 和 '),availability:0
  }));
}
async function choiceContext(record,world,worker,signal){
  const choice=record.node.choice,viewer=String(record.source.header.seat);
  const [{initial}]=await inspectSearchWorlds({client:worker,source:record.choiceSource||record.source,worlds:[world],signal});
  const original=originalSelection(record.source,initial.actions);
  if(!original.matched)return null;
  const resolutionChoice={name:choice.name,sourceId:choice.sourceId,ids:choice.picked};
  const baseline=await simulate(worker,world,[original.action],signal,false,resolutionChoice);
  if(!baseline.resolutionChoiceApplied||!terminal(baseline,viewer))return null;
  return {world,viewer,original:original.action,baseline:terminal(baseline,viewer),
    originalText:(choice.name==='Stock Up'?'拿 ':'放下 ')+choice.options.filter(c=>choice.picked.includes(c.id)).map(c=>c.name).join(' 和 ')};
}
async function timingContext(record,world,worker,signal){
  const {timingSource,node}=record,choice=node.choice,viewer=String(timingSource.header.seat);
  const [{initial}]=await inspectSearchWorlds({client:worker,source:timingSource,worlds:[world],signal});
  if(!initial.actions.some(a=>a.kind==='cast'&&a.cardName===choice.name&&String(a.cardId)===String(choice.sourceId)))return null;
  const timedCast={sourceId:choice.sourceId,turn:record.source.anchor.turn,phase:'MAIN2'};
  const resolutionChoice={name:choice.name,sourceId:choice.sourceId,ids:choice.picked};
  const run=await simulate(worker,world,[],signal,false,resolutionChoice,timedCast);
  if(!run.timedCastApplied||!run.resolutionChoiceApplied||!terminal(run,viewer))return null;
  return {world,viewer,baseline:terminal(run,viewer),timedCast,resolutionChoice,
    originalText:'战斗后施放 Show and Tell，放下 '+choice.options.filter(c=>choice.picked.includes(c.id)).map(c=>c.name).join(' 和 ')};
}
function listPlans(contexts){
  const plans=new Map();
  for(const ctx of contexts.filter(Boolean)){
    const options={own:ctx.own,opponent:ctx.reply?rankActions(ctx.reply.fork.actions,ctx.reply.fork.state,{width:8}).filter(a=>a.kind!=='pass'):[]};
    for(const [kind,actions] of Object.entries(options))for(const a of actions){
      const id=planId(kind,a),plan=plans.get(id)||{id,kind,label:describeAction(a,kind==='own'?ctx.initial.state:ctx.reply.fork.state,ctx.viewer),card:a.cardName||'',targets:a.targets||[],modeDescriptions:a.modeDescriptions||[],availability:0};
      plan.availability++;plans.set(id,plan);
    }
  }
  return [...plans.values()].sort((a,b)=>b.availability-a.availability);
}
function testPlan(choices,plan,ai){
  if(!choices.some(p=>p.id===plan.testId)||ai.has(plan.testId)||ai.size>=3)return;
  ai.set(plan.testId,plan.reason);
}
async function evaluate({record,context,plan,worker,signal}){
  if(!context)return null;
  const {world,viewer,original,reply}=context;
  let path,baseline=context.baseline,basePath=[original],resolutionChoice,timedCast;
  if(plan.kind==='timing'){
    path=[];basePath=[];resolutionChoice=context.resolutionChoice;timedCast={...context.timedCast,phase:'MAIN1'};
  }else if(plan.kind==='choice'){
    path=[original];
    resolutionChoice={name:record.node.choice.name,sourceId:record.node.choice.sourceId,ids:plan.ids};
  }else if(plan.kind==='opponent'){
    const action=reply?.fork.actions.find(a=>planId('opponent',a)===plan.id);
    if(!action)return null;
    basePath=reply.path;path=basePath.concat(action);
    if(basePath.length>1)baseline=terminal(await simulate(worker,world,basePath,signal),viewer);
  }else{
    const action=context.own.find(a=>planId('own',a)===plan.id);
    if(!action)return null;
    path=[action];
  }
  const run=await simulate(worker,world,path,signal,false,resolutionChoice,timedCast);
  if((resolutionChoice&&!run.resolutionChoiceApplied)||(timedCast&&!run.timedCastApplied))return null;
  const changed=terminal(run,viewer);
  return {world,baseline,changed,resolutionChoice,timedCast,originalText:context.originalText,basePath:basePath.map(compact),path:path.map(compact),run,flipped:isFlip(baseline,changed,record.node.outcome)};
}
function totals(samples,outcome){
  const pairs=samples.filter(s=>s?.baseline&&s?.changed);
  return {attempted:samples.length,completed:pairs.length,flips:pairs.filter(s=>s.flipped).length,
    reverse:pairs.filter(s=>isFlip(s.changed,s.baseline,outcome)).length};
}
async function findTurningPoints({records,forge,ask,signal,onProgress,deep=false}){
  const entries=[];
  for(const record of records){
    if(!record.node.outcome)continue;
    const contexts=await mapSearchWorlds(forge,record.worlds,(world,i,worker)=>attempt(
      ()=>makeContext({record,world,initial:record.checkedWorlds[i].initial,worker,signal}),signal),signal);
    const plans=listPlans(contexts.filter(c=>c?.baseline.outcome===record.node.outcome));
    const choiceWorlds=record.choiceWorlds?.()||[];
    const choiceContexts=await mapSearchWorlds(forge,choiceWorlds,(world,i,worker)=>attempt(
      ()=>choiceContext(record,world,worker,signal),signal),signal);
    const matching=choiceContexts.filter(c=>c&&(c.baseline.outcome===record.node.outcome)).length;
    if(matching)plans.push(...choicePlans(record.node.choice).map(p=>({...p,availability:matching})));
    const timingContexts=await mapSearchWorlds(forge,record.timingWorlds?.()||[],(world,i,worker)=>attempt(
      ()=>timingContext(record,world,worker,signal),signal),signal);
    const timingMatches=timingContexts.filter(c=>c&&(c.baseline.outcome===record.node.outcome)).length;
    if(timingMatches)plans.push({id:'timing:main1',kind:'timing',label:'战斗前施放 Show and Tell',availability:timingMatches});
    record.result.turningTest={direction:direction[record.node.outcome],comparableWorlds:Math.max(contexts.filter(Boolean).length,choiceContexts.filter(Boolean).length,timingContexts.filter(Boolean).length),plans:[],key:null};
    if(plans.length)entries.push({record,contexts,choiceContexts,timingContexts,plans});
  }
  if(!entries.length)return;
  onProgress('AI 正在选最可能改变胜负的具体动作。');
  const picked=await ask(
    '每个节点最多选 3 个确实值得跑的 testId。败局找能赢回来的打法。胜局找对手在原动作之后可能使己方输掉的具体操作，也找己方换了哪一步会输。优先选能解释胜负机制的，例如阻止当回合斩杀、保留唯一的解牌、绕过关键费用。优先覆盖玩家指定的打法。reason 一句话说明这一步想验证什么。只能选择提供的 ID。不同假设里的动作只是可测试选项，不能当成原局真实手牌。\n'+
    JSON.stringify(entries.map(({record,contexts,plans})=>({sourceLine:record.node.sourceLine,game:record.source.game,
      objective:direction[record.node.outcome],focus:record.focus,question:record.node.question,ideas:record.node.alternatives,
      original:contexts.find(Boolean)?.originalText,recordedChoice:record.node.choice,
      state:{turn:record.source.baseline.turnNumber,phase:record.source.baseline.phase,
        players:record.source.baseline.players.map(p=>({id:p.id,life:p.life,hand:p.hand?.filter(c=>c.name!=='Hidden card').map(c=>c.name),handSize:p.handSize,
          battlefield:p.battlefield?.map(c=>({id:c.id,name:c.name,tapped:c.tapped})),manaPool:p.manaPool})),
        stack:record.source.baseline.stack?.map(item=>({name:item.sourceCard?.name,description:item.abilityDescription}))},plans}))),Schema.turningTests);
  validate(picked,Schema.turningTests);
  for(const {record,contexts,choiceContexts,timingContexts,plans} of entries){
    const ai=new Map();
    for(const plan of picked.tests)if(plan.sourceLine===record.node.sourceLine)testPlan(plans,plan,ai);
    // Keep a legal option in each direction, even when the model overlooks it.
    const kinds=record.node.outcome==='win'?['opponent','own']:['own'];
    if(choiceContexts.some(Boolean))kinds.push('choice');
    if(timingContexts.some(Boolean))kinds.push('timing');
    for(const kind of kinds){
      if([...ai.keys()].some(id=>id.startsWith(kind+':')))continue;
      const fallback=plans.find(p=>p.kind===kind);
      if(fallback)ai.set(fallback.id,'');
    }
    const tested=plans.filter(p=>ai.has(p.id)).sort((a,b)=>[...ai.keys()].indexOf(a.id)-[...ai.keys()].indexOf(b.id));
    onProgress('第 '+record.source.game+' 局 T'+record.source.anchor.turn+' 正在对照原打法，验证 '+tested.length+' 个可能改变胜负的动作。');
    const byPlan=[];
    for(const plan of tested){
      const samples=await mapSearchWorlds(forge,plan.kind==='timing'?timingContexts:plan.kind==='choice'?choiceContexts:contexts,(context,i,worker)=>attempt(()=>evaluate({record,context,plan,worker,signal}),signal),signal);
      const stats=totals(samples,record.node.outcome);
      const witness=samples.find(s=>s?.flipped);
      byPlan.push({plan,stats,witness,reason:ai.get(plan.id)});
    }
    record.result.turningTest.plans=byPlan.map(({plan,stats,reason})=>({label:plan.label,kind:plan.kind,reason,...stats}));
    const selected=byPlan.filter(t=>t.witness).sort((a,b)=>b.stats.flips-a.stats.flips||a.stats.reverse-b.stats.reverse)[0];
    if(!selected)continue;
    const {plan,stats,witness,reason}=selected;
    const replay=await attempt(()=>simulate(forge,witness.world,witness.path,signal,true,witness.resolutionChoice,witness.timedCast),signal);
    if(!replay||witness.resolutionChoice&&!replay.resolutionChoiceApplied||witness.timedCast&&!replay.timedCastApplied||!isDeepStrictEqual(terminal(replay,String(record.source.header.seat)),witness.changed)||!isDeepStrictEqual(replay.executed,witness.run.executed))continue;
    const holdouts=(plan.kind==='timing'?record.timingHoldout?.():plan.kind==='choice'?record.choiceHoldout?.():record.buildHoldout?.())?.slice(0,deep?12:8)||[];
    onProgress('已找到胜负变化，正在用另一批牌序复核 '+plan.label+'。');
    const samples=await mapSearchWorlds(forge,holdouts,(world,i,worker)=>attempt(async()=>{
      let context;
      if(plan.kind==='timing')context=await timingContext(record,world,worker,signal);
      else if(plan.kind==='choice')context=await choiceContext(record,world,worker,signal);
      else{
        const [{initial}]=await inspectSearchWorlds({client:worker,source:record.source,worlds:[world],signal});
        context=await makeContext({record,world,initial,worker,signal});
      }
      return evaluate({record,context,plan,worker,signal});
    },signal),signal);
    const key={direction:direction[record.node.outcome],kind:plan.kind,change:plan.label,reason,
      condition:plan.kind==='timing'?'从战斗前同一个局面开始，双方路线只锁定 Show and Tell 的时机和放下的牌。':plan.kind==='choice'&&record.node.choice.name==='Stock Up'?'固定 Stock Up 实际看到的五张牌，换对手暗手和后续牌序再跑。':'',
      original:witness.originalText,originalPath:witness.basePath,changedPath:witness.path,
      baseline:witness.baseline,changed:witness.changed,discovery:stats,holdout:totals(samples,record.node.outcome)};
    if(holdouts.length&&(key.holdout.flips===0||key.holdout.flips<key.holdout.reverse)){
      record.result.turningTest.example=key;
      continue;
    }
    record.result.turningTest.key=key;
    record.result.quality={keep:true,reason:key.direction+' · '+plan.label,risks:[],confidence:'low'};
    record.turningWorld=witness.world;
    if(plan.kind==='timing')record.turningSource=record.timingSource;
    record.result.representative={...replay,worldId:witness.world.id,path:witness.path,scenario:witness.world.scenario};
  }
}
module.exports={gameOutcomes,isFlip,findTurningPoints};
