'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),zlib=require('node:zlib');
const Source=require('./search-source');
const {controlledComparison,withPublicHand,inspectControlledRoot}=require('./controlled-replay');
const {buildHoldout,recordedChoiceSource,seeds}=require('./search-review');
const {buildWorld}=require('./hidden-worlds');
const {originalSelection,compact,mapSearchWorlds}=require('./tree-search');
const {gameOutcomes}=require('./turning-points');
const {completePriorityReplay,stateKey}=require('./priority-replay');

const forgeOptionBounds={
  discoveryWorlds:{default:3,min:1,max:16},
  holdoutWorlds:{default:4,min:1,max:32},
  candidatesPerNode:{default:1,min:1,max:6},
  maxComparisons:{default:4,min:1,max:12}
};
function forgeSearchSettings(forge){
  const workers=forge.parallelism||1;
  return {...forgeOptionBounds,workers:{default:workers,min:1,max:workers}};
}
function readForgeOptions(value,forge){
  if(value!=null&&(typeof value!=='object'||Array.isArray(value)))throw Error('请选择有效的 Forge 搜索设置。');
  return Object.fromEntries(Object.entries(forgeSearchSettings(forge)).map(([key,{default:fallback,min,max}])=>{
    const n=value?.[key]??fallback;
    if(!Number.isInteger(n)||n<min||n>max)throw Error('Forge 搜索设置中的数字超出可用范围。');
    return [key,n];
  }));
}
const probeOptions={enumerateChoices:true,exhaustive:true,skipForcedPasses:true,horizonTurns:100};
const choiceIds=ids=>ids.map(Number).sort((a,b)=>a-b).join(', ');
const menu=actions=>[...new Map(actions.map(a=>[a.key,a])).values()];
const moveKey=(baseline,alternative)=>JSON.stringify([baseline,alternative]);
const sampleKey=sample=>moveKey(sample.baselineKey,sample.alternateKey);
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
  let source=Source.sourceAt(replay.model.sourceText,node.recovery?.from??node.sourceLine);
  if(node.choice)source=recordedChoiceSource(source,node.choice);
  return withPublicHand(source).source;
}
const profileAt=(replay,game)=>({decks:replay.matchDecks.byGame[game],catalog:replay.matchDecks.catalog});
const blindWorlds=(source,profile,count)=>seeds(source,count).map(seed=>buildWorld(source,profile.decks,profile.catalog,seed));

async function decisionMenus({source,node,world,worker,signal}){
  const viewer=String(source.header.seat);
  const actor=String(node.priorityPlayerId);
  const request=(command,route,extra={})=>worker.request({command,root:world.root,path:route.map(compact),
    searchProbe:true,...probeOptions,skipForcedPasses:!node.recovery,...extra},{signal});
  const anchor=await inspectControlledRoot({source,world,worker,signal});
  const initial=node.recovery?await request('expand',node.prefix):anchor;
  if(node.recovery&&stateKey(initial.state,viewer)!==node.stateKey)return {menus:[],request};
  const pass=node.kind!=='play'?initial.actions.find(a=>a.kind==='pass'&&String(a.actorId)===actor):null;
  const original=pass?{matched:true,key:pass.key,action:pass}:originalSelection(source,initial.actions);
  if(!original.matched)return {menus:[],request};
  const menus=[{prefix:node.prefix||[],baseline:original.action,actions:initial.actions}];
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
  const {menus,request}=await decisionMenus(context),viewer=String(context.source.header.seat),actor=String(context.node.priorityPlayerId),samples=[],errors=[];
  for(const {prefix,baseline,actions} of menus){
    const alternatives=menu(actions).filter(a=>a.key!==baseline.key&&String(a.actorId)===actor&&
      (!only||only.has(moveKey(baseline.key,a.key))));
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

async function discover({job,replay,forge,progress,nodes,profile,options}){
  const outcomes=gameOutcomes(replay.model),viewer=String(replay.model.header.seat);
  const signal=job.abort.signal;
  let checked=0;
  progress(job,'search','Forge 正在对照原操作与合法改法。');
  const rows=await mapSearchWorlds(forge,nodes,async (node,index,worker)=>{
    try{
      const source=preparedSource(replay,node),worlds=blindWorlds(source,profile,options.discoveryWorlds);
      const byMove=new Map(),errors=[];
      for(const world of worlds){
        const result=await samplesAt({source,node,world,worker,signal});
        errors.push(...result.errors);
        for(const sample of result.samples){
          const key=sampleKey(sample);
          const group=byMove.get(key)||[];group.push(sample);byMove.set(key,group);
        }
      }
      const outcome=String(node.priorityPlayerId)===viewer?outcomes[node.game]:'win';
      const candidates=[...byMove.values()].map(samples=>({samples,stats:counts(samples,outcome)}))
        .filter(x=>positive(x.stats,outcome)).sort((a,b)=>
          (b.stats.flips-b.stats.reverse)-(a.stats.flips-a.stats.reverse)||b.stats.faster-a.stats.faster);
      if(!candidates.length)return {line:node.sourceLine,errors,compared:byMove.size};
      const selected=new Map(candidates.slice(0,options.candidatesPerNode).map(candidate=>[sampleKey(candidate.samples[0]),candidate]));
      const holdouts=buildHoldout(source,profile,worlds,options.holdoutWorlds),verification=new Map();
      for(const world of holdouts){
        const result=await samplesAt({source,node,world,worker,signal},selected);
        for(const sample of result.samples){
          const key=sampleKey(sample),group=verification.get(key)||[];
          group.push(sample);verification.set(key,group);
        }
        errors.push(...result.errors);
      }
      const reviewed=[...selected].map(([key,candidate])=>{
        const samples=verification.get(key)||[],stats=counts(samples,outcome);
        return {key,candidate,samples,stats,supported:positive(stats,outcome)};
      }).sort((a,b)=>Number(b.supported)-Number(a.supported)||
        (b.stats.flips-b.stats.reverse)-(a.stats.flips-a.stats.reverse)||b.stats.faster-a.stats.faster);
      const {candidate:best,samples,stats,supported}=reviewed[0];
      const witness=samples.find(s=>meaningful(s,outcome))||best.samples.find(s=>meaningful(s,outcome));
      return {line:node.sourceLine,node,discovery:best.stats,holdout:stats,outcome,
        supported,errors,compared:byMove.size,reviewedCandidates:reviewed.map(({key,stats})=>({key,holdout:stats})),
        plan:{line:node.sourceLine,world:witness.world,discoveryWorlds:options.discoveryWorlds,
          holdouts:options.holdoutWorlds,...(node.recovery?{recovery:node.recovery}:{}),
          name:'T'+node.turn+'-'+node.cardName.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,52)+'-'+node.sourceLine,
          prefix:witness.prefix,baselineKey:witness.baselineKey,alternateKey:witness.alternateKey}};
    }catch(error){signal.throwIfAborted();return {line:node.sourceLine,errors:[error.message],compared:0};}
    finally{checked++;progress(job,'search','已核对 '+checked+'/'+nodes.length+' 个优先权节点。');}
  },signal,options.workers);
  const candidates=rows.filter(row=>row.supported&&String(row.node.priorityPlayerId)===viewer).sort((a,b)=>
    (b.holdout.flips-b.holdout.reverse)-(a.holdout.flips-a.holdout.reverse)||b.holdout.faster-a.holdout.faster||
    b.discovery.flips-a.discovery.flips||a.line-b.line).slice(0,options.maxComparisons);
  await fs.writeFile(path.join(job.dir,'forge-discovery.json'),JSON.stringify(rows,null,2));
  const attempts=new Map(rows.map(row=>[row.line,row]));
  return {candidates,scanned:nodes.length,compared:rows.filter(row=>row.compared).length,
    priority:nodes.map(({sourceLine,anchorLine,t,game,turn,phase,priorityPlayerId,kind,cardName,recovery})=>{
      const attempt=attempts.get(sourceLine);
      return {sourceLine,anchorLine,t,game,turn,phase,priorityPlayerId,kind,cardName,recovery,
        status:attempt?.compared?'compared':attempt?.errors.length?'blocked':'no-comparison',
      reason:attempt?.errors[0]};
    })};
}

async function runForgeFindings({job,replay,forge,progress}){
  const text=replay.model.sourceText,profile=profileAt(replay,job.game),signal=job.abort.signal;
  const options=readForgeOptions(job.forgeOptions,forge);
  const recorded=(replay.priorityNodes??=Source.priorityCandidates(text)).filter(node=>node.game===job.game);
  let completion,nodes=recorded;
  if(!job.comparisonPlan||job.comparisonPlan.some(plan=>plan.recovery)){
    progress(job,'restore','正在从原回放补全优先权窗口。');
    completion=await completePriorityReplay({text,nodes:recorded,profile,forge,signal,workers:options.workers,
      onProgress:(checked,total)=>progress(job,'restore','已核对 '+checked+'/'+total+' 段回放间隔。')});
    await fs.writeFile(path.join(job.dir,'completed-priorities.esreplay'),zlib.gzipSync(completion.text));
    await fs.writeFile(path.join(job.dir,'priority-coverage.json'),JSON.stringify(completion.gaps,null,2));
    nodes=recorded.map(node=>({...node,...completion.routed.get(node.sourceLine)})).concat(completion.added)
      .sort((a,b)=>(a.anchorLine??a.sourceLine)-(b.anchorLine??b.sourceLine)||Number(b.kind==='recovered')-Number(a.kind==='recovered')||a.sourceLine-b.sourceLine);
  }
  const discovery=job.comparisonPlan?null:await discover({job,replay,forge,progress,nodes,profile,options});
  const candidates=job.comparisonPlan?.map(plan=>({plan}))||discovery.candidates;
  const index=new Map(nodes.map(node=>[node.sourceLine,node]));
  const comparisons=[];
  for(const {plan,discovery,holdout} of candidates){
    const node=plan.recovery?nodes.find(node=>node.recovery&&node.recovery.from===plan.recovery.from&&
      node.recovery.to===plan.recovery.to&&node.recovery.steps===plan.recovery.steps):index.get(plan.line);
    if(!node)throw Error('对照中的起点不属于当前回放，或补全的窗口已经变化。');
    if(plan.recovery&&(plan.prefix.length!==node.prefix.length||plan.prefix.some((action,i)=>action.key!==node.prefix[i].key||
      String(action.actorId)!==String(node.prefix[i].actorId)||action.kind!==node.prefix[i].kind)))throw Error('复现计划中的优先权推进路线与补全结果不一致。');
    const source=preparedSource(replay,plan.recovery?node:recorded.find(n=>n.sourceLine===plan.line)||node);
    const worlds=blindWorlds(source,profile,plan.discoveryWorlds??forgeOptionBounds.discoveryWorlds.default);
    const world=worlds.concat(buildHoldout(source,profile,worlds,plan.holdouts||0)).find(w=>w.id===plan.world);
    if(!world)throw Error('无法复现对照所用暗手，请核对双方牌表与回放。');
    progress(job,'compare','正在重放 T'+node.turn+' '+node.cardName+' 的两条路线。');
    const currentPlan={...plan,line:node.sourceLine};
    const result=await controlledComparison({source,world,plan:currentPlan,worker:forge,signal,actor:node.priorityPlayerId});
    const id=comparisons.length,arms=[];
    for(const [i,arm] of result.arms.entries()){
      await fs.writeFile(path.join(job.dir,'comparison-'+id+'-'+i+'.esreplay'),arm.bytes);
      const {bytes,...info}=arm;
      arms.push({...info,downloadUrl:'/api/jobs/'+job.id+'/comparisons/'+id+'/'+i});
    }
    comparisons.push({...result,arms,plan:currentPlan,discovery,holdout,
      ...(['priority','recovered'].includes(node.kind)?{comparisonBaseline:'pass'}:{})});
  }
  await fs.writeFile(path.join(job.dir,'comparison-plan.json'),JSON.stringify(comparisons.map(c=>c.plan),null,2));
  return {comparisons,scanned:discovery?.scanned??null,compared:discovery?.compared??null,priority:discovery?.priority,
    ...(discovery?{forgeOptions:options}:{}),
    ...(completion?{completedReplayUrl:'/api/jobs/'+job.id+'/completed-priorities',recovered:completion.added.length}:{}),
    planUrl:comparisons.length?'/api/jobs/'+job.id+'/comparison-plan':null};
}

module.exports={runForgeFindings,forgeSearchSettings,readForgeOptions};
