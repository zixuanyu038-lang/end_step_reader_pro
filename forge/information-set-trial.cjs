'use strict';
const {createHash}=require('node:crypto');
const {compact}=require('../tree-search');

function observationKey(state,actions,path){
  const actor=String(state.priorityPlayerId);
  const publicCards=cards=>(cards||[]).map(c=>c.faceDown?
    {id:c.id,faceDown:true,tapped:c.tapped,ownerId:c.ownerId,controllerId:c.controllerId,counters:c.counters}:c);
  const players=state.players.map(p=>{
    const {hand,battlefield,graveyard,exile,commandZone,...publicStats}=p;
    return {...publicStats,hand:String(p.id)===actor?hand:undefined,
      battlefield:publicCards(battlefield),graveyard:publicCards(graveyard),exile:publicCards(exile),commandZone:publicCards(commandZone)};
  });
  const history=path.filter(a=>a.kind!=='choice'||String(a.actorId)===actor).map(a=>a.key);
  const choices=actions.filter(a=>a.kind==='choice').map(a=>a.label);
  const stack=(state.stack||[]).map(item=>item.sourceCard?.faceDown&&String(item.controllerId)!==actor?
    {controllerId:item.controllerId,sourceCard:publicCards([item.sourceCard])[0],targets:item.targets}:item);
  const observation={actor,turn:state.turnNumber,phase:state.phase,active:state.activePlayerId,
    players,stack,day:state.isDay,night:state.isNight,storm:state.stormCount,choices,history};
  return createHash('sha256').update(JSON.stringify(observation)).digest('hex');
}

function createInformationSetSearch({worlds,viewer,checkpoint}){
  const sets=new Map();
  let samples=checkpoint?.samples||0;
  for(const saved of checkpoint?.observations||[]){
    const {key,actor}=saved;
    sets.set(key,{actor,worlds:new Set(saved.worlds),actions:new Map(saved.actions.map(({action,...stats})=>[action,stats]))});
  }
  function select(world,state,actions,path){
    const actor=String(state.priorityPlayerId),key=observationKey(state,actions,path);
    const entry=sets.get(key)||{actor,worlds:new Set(),actions:new Map()};
    entry.worlds.add(world.id);
    sets.set(key,entry);
    const options=actions.map(action=>{
      const stats=entry.actions.get(action.key)||{label:action.label,availability:0,visits:0,reward:0};
      stats.availability++;
      entry.actions.set(action.key,stats);
      return {action,stats};
    });
    const value=({stats})=>stats.visits?(actor===String(viewer)?1:-1)*stats.reward/stats.visits+
      Math.sqrt(2*Math.log(stats.availability)/stats.visits):Infinity;
    const noOp=a=>a.kind==='pass'||a.kind==='choice'&&a.label?.endsWith('[]');
    const chosen=options.reduce((best,candidate)=>{
      const next=value(candidate),prior=value(best);
      return next>prior||next===prior&&noOp(best.action)&&!noOp(candidate.action)?candidate:best;
    });
    return {key,...chosen};
  }
  function backpropagate(visited,winner){
    const reward=winner==null?0:String(winner)===String(viewer)?1:-1;
    for(const stats of visited){stats.visits++;stats.reward+=reward;}
  }
  function walk(worldId){
    const world=worlds.find(w=>w.id===worldId),visited=[];
    return {
      next(state,actions,path){
        const {action,stats}=select(world,state,actions,path);
        visited.push(stats);
        return action;
      },
      terminal(winner){backpropagate(visited,winner);}
    };
  }
  async function sample(request,signal){
    const world=worlds[samples++%worlds.length],path=[],visited=[];
    let result,rootObservation;
    for(;;){
      signal?.throwIfAborted();
      result=await request(world,'expand',path);
      if(result.stopReason!=='decision'||!result.actions.length)break;
      const {key,action,stats}=select(world,result.state,result.actions,path);
      rootObservation??=key;
      path.push(compact(action));
      visited.push(stats);
      if(!stats.visits){result=await request(world,'simulate',path);break;}
    }
    const terminal=result.stopReason==='game_over';
    const winner=result.state?.winnerId??null;
    if(terminal)backpropagate(visited,winner);
    return {world:world.id,rootObservation,path,stop:result.stopReason,winner,turn:result.state?.turnNumber};
  }
  function snapshot(){
    return {samples,observations:[...sets].map(([key,e])=>({key,actor:e.actor,worlds:[...e.worlds],
      actions:[...e.actions].map(([action,stats])=>({action,...stats}))}))};
  }
  return {sample,snapshot,walk};
}

async function informationSetTrial({client,worlds,viewer,samples}){
  const search=createInformationSetSearch({worlds,viewer}),log=[];
  const request=(world,command,path)=>client.request({command,root:world.root,path,searchProbe:true,
    exhaustive:true,enumerateChoices:true,skipForcedPasses:true,horizonTurns:100});
  for(let i=0;i<samples;i++)log.push(await search.sample(request));
  return {...search.snapshot(),log};
}

module.exports={observationKey,createInformationSetSearch,informationSetTrial};
