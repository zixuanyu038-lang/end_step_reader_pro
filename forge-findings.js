'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const Source=require('./search-source');
const {controlledComparison,withPublicHand,inspectControlledRoot}=require('./controlled-replay');
const {buildHoldout,recordedChoiceSource,seeds}=require('./search-review');
const {buildWorld}=require('./hidden-worlds');
const {originalSelection,compact,mapSearchWorlds}=require('./tree-search');
const {gameOutcomes}=require('./turning-points');

const probeOptions={enumerateChoices:true,exhaustive:true,skipForcedPasses:true,horizonTurns:100};
const choiceIds=ids=>ids.map(Number).sort((a,b)=>a-b).join(', ');
const menu=actions=>[...new Map(actions.map(a=>[a.key,a])).values()];
const terminal=(result,viewer)=>result.stopReason==='game_over'?
  {result:result.state.winnerId==null?'draw':String(result.state.winnerId)===viewer?'win':'loss',turn:result.state.turnNumber}:null;
function counts(samples,outcome){
  let flips=0,reverse=0,faster=0,slower=0;
  const other=outcome==='loss'?'win':'loss';
  for(const {baseline,alternative} of samples){
    if(baseline.result===outcome&&alternative.result===other)flips++;
    if(baseline.result===other&&alternative.result===outcome)reverse++;
    if(baseline.result==='win'&&alternative.result==='win'){
      if(alternative.turn<baseline.turn-1)faster++;
      if(alternative.turn>baseline.turn+1)slower++;
    }
  }
  return {compared:samples.length,flips,reverse,faster,slower};
}
const positive=(stats,outcome)=>stats.flips>stats.reverse||
  outcome==='loss'&&!stats.flips&&!stats.reverse&&stats.faster>stats.slower;
const meaningful=(sample,outcome)=>positive(counts([sample],outcome),outcome);

function preparedSource(replay,node){
  let source=Source.sourceAt(replay.model.sourceText,node.sourceLine);
  if(node.choice)source=recordedChoiceSource(source,node.choice);
  return withPublicHand(source).source;
}
const profileAt=(replay,game)=>({decks:replay.matchDecks.byGame[game],catalog:replay.matchDecks.catalog});
const blindWorlds=(source,profile)=>seeds(source,3).map(seed=>buildWorld(source,profile.decks,profile.catalog,seed));

async function decisionMenus({source,node,world,worker,signal}){
  const viewer=String(source.header.seat);
  const request=(command,route,extra={})=>worker.request({command,root:world.root,path:route.map(compact),
    searchProbe:true,...probeOptions,...extra},{signal});
  const initial=await inspectControlledRoot({source,world,worker,signal});
  const pass=node.kind==='pass'?initial.actions.find(a=>a.kind==='pass'&&String(a.actorId)===viewer):null;
  const original=pass?{matched:true,key:pass.key,action:pass}:originalSelection(source,initial.actions);
  if(!original.matched)return {menus:[],request};
  const menus=[{prefix:[],baseline:original.action,actions:initial.actions}];
  if(node.choice&&menus.length){
    const prefix=[compact(original.action)],choice=node.choice;
    const choiceKey='choice:'+viewer+':'+choice.sourceId+':[';
    const picked=choiceIds(choice.picked);
    for(;;){
      signal?.throwIfAborted();
      const current=await request('expand',prefix);
      if(current.stopReason!=='decision')break;
      const baseline=current.actions.find(a=>a.key.startsWith(choiceKey)&&
        choiceIds(a.key.slice(choiceKey.length,-1).split(',').filter(Boolean))===picked);
      if(baseline){menus.push({prefix,baseline,actions:current.actions});break;}
      const onStack=current.state.stack.some(s=>String(s.sourceCard?.id)===String(choice.sourceId));
      const pass=current.actions.find(a=>a.kind==='pass');
      if(!onStack||!pass)break;
      prefix.push(compact(pass));
    }
  }
  return {menus,request};
}

async function samplesAt(context,only){
  const {menus,request}=await decisionMenus(context),viewer=String(context.source.header.seat),samples=[],errors=[];
  for(const {prefix,baseline,actions} of menus){
    if(only&&baseline.key!==only.baselineKey)continue;
    const alternatives=menu(actions).filter(a=>a.key!==baseline.key&&String(a.actorId)===viewer&&
      (!only||a.key===only.alternateKey));
    if(!alternatives.length)continue;
    const base=terminal(await request('simulate',prefix.concat(baseline)),viewer);
    if(!base)continue;
    for(const action of alternatives){
      try{
        const alternative=terminal(await request('simulate',prefix.concat(action)),viewer);
        if(alternative)samples.push({world:context.world.id,prefix,baselineKey:baseline.key,alternateKey:action.key,
          baseline:base,alternative});
      }catch(error){context.signal?.throwIfAborted();errors.push(error.message);}
    }
  }
  return {samples,errors};
}

async function discover({job,replay,forge,progress}){
  const outcomes=gameOutcomes(replay.model),priority=(replay.priorityNodes??=Source.priorityCandidates(replay.model.sourceText))
    .filter(node=>node.game===job.game&&outcomes[node.game]);
  const nodes=priority.filter(node=>node.kind!=='priority');
  const signal=job.abort.signal;
  let checked=0;
  progress(job,'search','Forge 正在对照原操作与合法改法。');
  const rows=await mapSearchWorlds(forge,nodes,async (node,index,worker)=>{
    try{
      const source=preparedSource(replay,node),profile=profileAt(replay,node.game),worlds=blindWorlds(source,profile);
      const byMove=new Map(),errors=[];
      for(const world of worlds){
        const result=await samplesAt({source,node,world,worker,signal});
        errors.push(...result.errors);
        for(const sample of result.samples){
          const key=JSON.stringify([sample.baselineKey,sample.alternateKey]);
          const group=byMove.get(key)||[];group.push(sample);byMove.set(key,group);
        }
      }
      const outcome=outcomes[node.game];
      const candidates=[...byMove.values()].map(samples=>({samples,stats:counts(samples,outcome)}))
        .filter(x=>positive(x.stats,outcome)).sort((a,b)=>
          (b.stats.flips-b.stats.reverse)-(a.stats.flips-a.stats.reverse)||b.stats.faster-a.stats.faster);
      const best=candidates[0];
      if(!best)return {line:node.sourceLine,errors,compared:byMove.size};
      const holdouts=buildHoldout(source,profile,worlds,4),verification=[];
      for(const world of holdouts){
        const result=await samplesAt({source,node,world,worker,signal},best.samples[0]);
        verification.push(...result.samples);errors.push(...result.errors);
      }
      const stats=counts(verification,outcome);
      const witness=verification.find(s=>meaningful(s,outcome))||best.samples.find(s=>meaningful(s,outcome));
      return {line:node.sourceLine,node,discovery:best.stats,holdout:stats,outcome,
        supported:positive(stats,outcome),errors,compared:byMove.size,
        plan:{line:node.sourceLine,world:witness.world,holdouts:4,
          name:'T'+node.turn+'-'+node.cardName.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,52)+'-'+node.sourceLine,
          prefix:witness.prefix,baselineKey:witness.baselineKey,alternateKey:witness.alternateKey}};
    }catch(error){signal.throwIfAborted();return {line:node.sourceLine,errors:[error.message],compared:0};}
    finally{checked++;progress(job,'search','已核对 '+checked+'/'+nodes.length+' 个录像决策。');}
  },signal);
  const candidates=rows.filter(row=>row.supported).sort((a,b)=>
    (b.holdout.flips-b.holdout.reverse)-(a.holdout.flips-a.holdout.reverse)||b.holdout.faster-a.holdout.faster||
    b.discovery.flips-a.discovery.flips||a.line-b.line).slice(0,4);
  await fs.writeFile(path.join(job.dir,'forge-discovery.json'),JSON.stringify(rows,null,2));
  const attempts=new Map(rows.map(row=>[row.line,row]));
  return {candidates,scanned:nodes.length,compared:rows.filter(row=>row.compared).length,
    priority:priority.map(({sourceLine,turn,phase,priorityPlayerId,kind,cardName})=>{
      const attempt=attempts.get(sourceLine);
      return {sourceLine,turn,phase,priorityPlayerId,kind,cardName,status:kind==='priority'?'no-recorded-action':
        attempt?.compared?'compared':attempt?.errors.length?'blocked':'no-comparison',
      reason:attempt?.errors[0]};
    })};
}

async function runForgeFindings({job,replay,forge,progress}){
  const discovery=job.comparisonPlan?null:await discover({job,replay,forge,progress});
  const candidates=job.comparisonPlan?.map(plan=>({plan}))||discovery.candidates;
  const index=new Map((replay.priorityNodes??=Source.priorityCandidates(replay.model.sourceText)).map(node=>[node.sourceLine,node]));
  const comparisons=[];
  for(const {plan,discovery,holdout} of candidates){
    const node=index.get(plan.line);
    if(!node)throw Error('对照中的起点不属于当前回放。');
    const source=preparedSource(replay,node),profile=profileAt(replay,node.game);
    const worlds=blindWorlds(source,profile);
    const world=worlds.concat(buildHoldout(source,profile,worlds,plan.holdouts||0)).find(w=>w.id===plan.world);
    if(!world)throw Error('无法复现对照所用暗手，请核对双方牌表与回放。');
    progress(job,'compare','正在重放 T'+node.turn+' '+node.cardName+' 的两条路线。');
    const result=await controlledComparison({source,world,plan,worker:forge,signal:job.abort.signal});
    const id=comparisons.length,arms=[];
    for(const [i,arm] of result.arms.entries()){
      await fs.writeFile(path.join(job.dir,'comparison-'+id+'-'+i+'.esreplay'),arm.bytes);
      const {bytes,...info}=arm;
      arms.push({...info,downloadUrl:'/api/jobs/'+job.id+'/comparisons/'+id+'/'+i});
    }
    comparisons.push({...result,arms,plan,discovery,holdout});
  }
  await fs.writeFile(path.join(job.dir,'comparison-plan.json'),JSON.stringify(comparisons.map(c=>c.plan),null,2));
  return {comparisons,scanned:discovery?.scanned??null,compared:discovery?.compared??null,priority:discovery?.priority,
    planUrl:comparisons.length?'/api/jobs/'+job.id+'/comparison-plan':null};
}

module.exports={runForgeFindings};
