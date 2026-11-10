'use strict';
const {compact,deduplicate,inspectSearchWorlds,mapSearchWorlds,originalSelection,rankActions}=require('./tree-search');

const settings={includeTrace:false,horizonTurns:100,maxChoices:2000,maxSteps:4000};
const actionLabel=action=>action.label||action.cardName||action.key;
const signature=action=>JSON.stringify([
  action.kind,action.cardName,action.abilityIndex,action.modes,action.targets,action.x,action.manaCost,
]);

function terminal(run,viewer){
  if(run.stopReason!=='game_over'||run.state.status!=='COMPLETE')return null;
  return {value:run.state.winnerId==null?0.5:Number(String(run.state.winnerId)===String(viewer)),turn:run.state.turnNumber};
}

function pairedCounts(pairs){
  const counts={completed:0,better:0,same:0,worse:0,faster:0,sameTurn:0,slower:0};
  for(const [original,alternative] of pairs){
    if(!original||!alternative)continue;
    counts.completed++;
    counts[alternative.value>original.value?'better':alternative.value<original.value?'worse':'same']++;
    if(original.value===1&&alternative.value===1){
      counts[alternative.turn<original.turn?'faster':alternative.turn>original.turn?'slower':'sameTurn']++;
    }
  }
  return counts;
}

async function verifyPair({source,candidate,discoveryWorld,worlds,forge,signal}){
  const viewer=String(source.header.seat),opening=candidate.path[0];
  const results={status:'illustration',rules:forge.rules||null,original:null,alternative:opening&&actionLabel(opening),attempted:0,
    native:pairedCounts([]),challenge:pairedCounts([]),appliedChallenge:pairedCounts([]),replies:[],discovery:[],samples:[],calls:0};
  if(!opening||String(opening.actorId)!==viewer)return results;
  async function request(world,command,path,worker=forge){
    signal?.throwIfAborted();
    results.calls++;
    return worker.request({command,root:world.root,path:path.map(compact),...settings,searchProbe:command==='simulate'},{signal});
  }
  const run=(world,path,worker)=>request(world,'simulate',path,worker).then(result=>terminal(result,viewer));
  const opponent=String(1-Number(viewer));
  const reachPriority=async(world,path,actor,worker)=>{
    let fork=await request(world,'expand',path,worker);
    if(fork.stopReason==='decision'&&String(fork.state.priorityPlayerId)!==actor){
      const pass=fork.actions.find(a=>a.kind==='pass');
      if(pass){path=path.concat(pass);fork=await request(world,'expand',path,worker);}
    }
    if(fork.stopReason!=='decision'||String(fork.state.priorityPlayerId)!==actor)return null;
    return {path,fork};
  };

  // Discover on the original search world only. Later worlds may trigger this
  // exact reply or fall back to the same engine continuation on both arms.
  async function findReply(action,arm){
    const node=await reachPriority(discoveryWorld,[action],opponent);
    if(!node)return null;
    const {path,fork}=node;
    const actions=deduplicate(fork.actions.filter(a=>a.kind!=='pass'));
    actions.sort((a,b)=>Number((b.targets||[]).flat().some(t=>t.startsWith('s:')))-
      Number((a.targets||[]).flat().some(t=>t.startsWith('s:'))));
    let selected=null;
    for(const reply of actions.slice(0,2)){
      const replyPath=path.concat(reply),outcome=await run(discoveryWorld,replyPath);
      const probe={arm,reply:actionLabel(reply),outcome,recovery:[]};
      results.discovery.push(probe);
      if(outcome&&(!selected||outcome.value<selected.value)){
        selected={value:outcome.value,turn:fork.state.turnNumber,phase:fork.state.phase,
          signature:signature(reply),label:actionLabel(reply),applications:0};
      }
      if(arm!=='alternative'||!outcome||outcome.value===1)continue;
      const next=await reachPriority(discoveryWorld,replyPath,viewer);
      if(!next)continue;
      const recoveries=rankActions(next.fork.actions.filter(a=>a.kind!=='pass'),next.fork.state,{width:2});
      for(const recovery of recoveries){
        const recoveryOutcome=await run(discoveryWorld,next.path.concat(recovery));
        probe.recovery.push({action:actionLabel(recovery),outcome:recoveryOutcome});
      }
    }
    return selected;
  }

  const cleanWorld=world=>{
    const root={...world.root};delete root.intent;
    return {...world,root};
  };
  discoveryWorld=cleanWorld(discoveryWorld);
  let policies;
  try{
    const initial=await request(discoveryWorld,'expand',[]);
    const original=originalSelection(source,initial.actions);
    if(!original.matched||original.key===opening.key){
      results.reason=original.reason||'胜局与原局使用同一个首手。';
      return results;
    }
    results.original=actionLabel(original.action);
    policies=[await findReply(original.action,'original'),await findReply(opening,'alternative')];
    results.replies=policies.flatMap((policy,i)=>policy?[{arm:i?'alternative':'original',label:policy.label,applications:0}]:[]);
  }catch(error){
    signal?.throwIfAborted();
    results.reason='未完成发现世界的反手检查。'+error.message;
    return results;
  }

  async function challenge(world,action,policy,native,worker){
    if(!policy)return {outcome:native,applied:false};
    const node=await reachPriority(world,[action],opponent,worker);
    if(!node||node.fork.state.turnNumber!==policy.turn||node.fork.state.phase!==policy.phase)return {outcome:native,applied:false};
    const matches=node.fork.actions.filter(reply=>signature(reply)===policy.signature);
    if(matches.length!==1)return {outcome:native,applied:false};
    return {outcome:await run(world,node.path.concat(matches[0]),worker),applied:true};
  }
  const seen=new Set([discoveryWorld.root.stateText]);
  const holdouts=worlds.map(cleanWorld).filter(world=>{
    const key=world.root.stateText;
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
  results.attempted=holdouts.length;
  const samples=await mapSearchWorlds(forge,holdouts,async (world,index,worker)=>{
    try{
      results.calls++;
      const [{initial}]=await inspectSearchWorlds({client:worker,source,worlds:[world],signal});
      const original=originalSelection(source,initial.actions),alternative=initial.actions.find(a=>a.key===opening.key);
      if(!original.matched||!alternative||original.key===alternative.key)return {};
      const actions=[original.action,alternative],native=[],challenges=[];
      for(const action of actions)native.push(await run(world,[action],worker));
      if(!native.every(Boolean))return {};
      let lastError;
      for(const [i,action] of actions.entries()){
        try{challenges.push(await challenge(world,action,policies[i],native[i],worker));}
        catch(error){signal?.throwIfAborted();lastError=error.message;challenges.push({outcome:null,applied:false});}
      }
      return {lastError,sample:{id:world.id,native,challenge:challenges.map(item=>item.outcome),applied:challenges.map(item=>item.applied)}};
    }catch(error){
      signal?.throwIfAborted();
      return {lastError:error.message};
    }
  },signal);
  for(const {lastError,sample} of samples){
    if(lastError)results.lastError=lastError;
    if(sample)results.samples.push(sample);
  }
  results.native=pairedCounts(results.samples.map(s=>s.native));
  results.challenge=pairedCounts(results.samples.map(s=>s.challenge));
  results.appliedChallenge=pairedCounts(results.samples.filter(s=>s.applied[1]).map(s=>s.challenge));
  for(const reply of results.replies){
    reply.applications=results.samples.filter(s=>s.applied[reply.arm==='alternative'?1:0]&&s.challenge.every(Boolean)).length;
  }
  // At least six favorable and zero unfavorable pairs in each panel
  // (one-sided exact sign probability at most 1/64 under equal odds).
  const consistent=counts=>counts.completed===results.attempted&&counts.completed>=8&&counts.better>=6&&counts.worse===0;
  if(consistent(results.native)&&consistent(results.challenge)&&results.appliedChallenge.better>=2){
    results.status='supported';
  }
  return results;
}

function publicVerification(result){
  if(!result)return null;
  const {samples,lastError,...summary}=result;
  return summary;
}

module.exports={verifyPair,pairedCounts,publicVerification};
