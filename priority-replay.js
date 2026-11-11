'use strict';
const {exactPhase,sourceAt}=require('./search-source');
const {withPublicHand,inspectControlledRoot}=require('./controlled-replay');
const {visibleState}=require('./forge-replay');
const {buildWorld}=require('./hidden-worlds');
const {seeds}=require('./search-review');
const {mapSearchWorlds,compact,originalSelection}=require('./tree-search');

const enginePhases={BEGIN_COMBAT:'COMBAT_BEGIN',DECLARE_ATTACKERS:'COMBAT_DECLARE_ATTACKERS',
  DECLARE_BLOCKERS:'COMBAT_DECLARE_BLOCKERS',FIRST_STRIKE_DAMAGE:'COMBAT_FIRST_STRIKE_DAMAGE',
  END_COMBAT:'COMBAT_END',END_STEP:'END_OF_TURN'};
const phases=['UNTAP','UPKEEP','DRAW','MAIN1','BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS',
  'FIRST_STRIKE_DAMAGE','COMBAT_DAMAGE','END_COMBAT','MAIN2','END_STEP','CLEANUP'];
const point=state=>[Number(state.turnNumber),exactPhase(state),String(state.activePlayerId),String(state.priorityPlayerId)];
const counterName=k=>({'+1/+1':'P1P1','-1/-1':'M1M1'})[k]||k.toUpperCase();
const poolName=k=>({WHITE:'W',BLUE:'U',BLACK:'B',RED:'R',GREEN:'G',COLORLESS:'C'})[k.toUpperCase()]||k.toUpperCase();
const pairs=(o,rename)=>Object.entries(o||{}).filter(([,v])=>v).map(([k,v])=>[rename(k),Number(v)]).sort();
const card=c=>[String(c.id),c.name,!!c.tapped,!!c.isAttacking,!!c.isBlocking,!!c.hasSummoningSickness,
  !!c.isTransformed,!!c.isPhasedOut,String(c.controllerId),Number(c.damage||0),
  [...(c.types||[])].sort(),c.types?.includes('Creature')?[c.power,c.toughness]:null,pairs(c.counters,counterName)];
const zone=(p,k)=>p[k]?.map(card).sort((a,b)=>a[0].localeCompare(b[0]))||[];
const stack=state=>(state.stack||[]).map(s=>[String(s.sourceCard.id),!!s.isTrigger,!!s.isAbility,
  String(s.controllerId??s.sourceCard.controllerId),(s.targets||[]).map(t=>[String(t.id),t.zone])]);

function stateKey(state,viewer){
  return JSON.stringify([point(state),stack(state),state.players.map(p=>[p.life,p.handSize,p.librarySize,
    pairs(p.manaPool,poolName),zone(p,'battlefield'),zone(p,'graveyard'),zone(p,'exile'),
    String(p.id)===viewer?(p.hand||[]).map(c=>[String(c.id),c.name]).sort():null])]);
}

function recoverWindows(windows,from,to,viewer,recordedPhases,recordedStates=new Set()){
  const start=stateKey(from.baseline,viewer),end=stateKey(to.baseline,viewer);
  if(!windows.length||stateKey(windows[0].state,viewer)!==start)return null;
  const endIndex=windows.findIndex((w,i)=>i>0&&stateKey(w.state,viewer)===end);
  if(endIndex<0)return null;
  const seenPhases=new Set(recordedPhases),recovered=[],prefix=[];
  for(const [i,window] of windows.slice(0,endIndex).entries()){
    const [turn,phase,activePlayerId,priorityPlayerId]=point(window.state);
    const phaseId=turn+':'+phase;
    if(!seenPhases.has(phaseId)){
      seenPhases.add(phaseId);
      recovered.push({kind:'phase',turn,phase,activePlayerId});
    }
    const key=stateKey(window.state,viewer);
    if(i&&!recordedStates.has(key)&&window.hasAlternatives)recovered.push({kind:'recovered',turn,phase,priorityPlayerId,
      prefix:prefix.slice(),stateKey:key,state:visibleState(window.state,viewer)});
    prefix.push(compact(window.advance));
  }
  return {recovered,endPrefix:prefix};
}

const manualEvent=new Set(['SPELL_CAST','LAND_PLAYED','ABILITY_ACTIVATED','MULLIGAN','GAME_OUTCOME']);
const recorderAction=new Set(['PASS_PRIORITY','SET_PHASE_STOPS','SET_AUTO_YIELDS']);
const castInput=new Set(['PLAY_CARD','AUTO_PAY','TAP_MANA','CHOOSE_MODE','CHOOSE_TARGETS','CHOOSE_COLOR','CHOOSE_TYPE','CHOOSE_X']);

async function completePriorityReplay({text,nodes,profile,forge,signal,workers,onProgress=()=>{}}){
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  const records=rows.map(raw=>raw.trim()?JSON.parse(raw):null);
  const viewer=String(records[0].seat),recordedPhases=new Set(),selectedGame=nodes[0]?.game;
  const gameCount=records.reduce((count,row)=>row?.k==='chapter'&&row.edge==='start'?Math.max(count,row.game):count,1);
  let turn,game=1;
  for(const row of records){
    if(row?.k==='chapter'&&row.edge==='start'){game=row.game;turn=undefined;}
    if(game!==selectedGame)continue;
    if(row?.event?.type==='TURN_BEGAN')turn=Number(row.event.turnNumber);
    if(row?.event?.type==='TURN_PHASE')recordedPhases.add(turn+':'+exactPhase(row.event));
    if(row?.k==='key')recordedPhases.add(Number(row.state.turnNumber)+':'+exactPhase(row.state));
  }
  const boundary=n=>n.anchorLine??n.sourceLine;
  const timeline=nodes.slice().sort((a,b)=>boundary(a)-boundary(b));
  const sources=new Map();
  function getSource(node){
    if(!sources.has(node.sourceLine))sources.set(node.sourceLine,withPublicHand(sourceAt(text,node.sourceLine)).source);
    return sources.get(node.sourceLine);
  }
  const gaps=timeline.flatMap((from,i)=>{
    const targets=[];
    let left=boundary(from);
    for(const to of timeline.slice(i+1)){
      const right=boundary(to);
      if(to.turn<from.turn||to.turn>from.turn+1||!phases.includes(to.phase))break;
      if(right<=left)continue;
      const between=records.slice(left-1,right-1);
      if(between.some((r,offset)=>{
        const line=left+offset,recordedCast=from.kind==='play'&&line<=from.sourceLine;
        if(r?.k==='action'&&!recorderAction.has(r.action.type))return !recordedCast||!castInput.has(r.action.type)||
          r.action.type==='PLAY_CARD'&&line!==boundary(from);
        return manualEvent.has(r?.event?.type)&&!(recordedCast&&line===from.sourceLine);
      }))break;
      targets.push(to);left=right;
      if(to.kind==='pass'||to.kind==='play')break;
    }
    return targets.length?[{from,targets}]:[];
  });
  let checked=0;
  const runs=await mapSearchWorlds(forge,gaps,async ({from,targets},_,worker)=>{
    const limit=targets.at(-1);
    try{
      const first=getSource(from),ends=targets.flatMap(node=>{
        try{return [{node,source:getSource(node)}];}catch{return [];}
      });
      const world=buildWorld(first,profile.decks,profile.catalog,seeds(first,1)[0]);
      const initial=await inspectControlledRoot({source:first,world,worker,signal});
      const recorded=from.kind==='play'?originalSelection(first,initial.actions):null;
      if(recorded&&!recorded.matched)return {from:from.sourceLine,to:limit.sourceLine,reason:recorded.reason};
      const path=recorded?[compact(recorded.action)]:[];
      const walk=await worker.request({command:'walk-priority',root:world.root,exhaustive:true,searchProbe:true,
        throughTurn:limit.turn,throughPhase:enginePhases[limit.phase]||limit.phase,path},{signal});
      const windows=walk.windows||[],seen=new Set(ends.map(({source})=>stateKey(source.baseline,viewer)));
      if(recorded)windows.unshift({state:initial.state,advance:recorded.action});
      const matches=ends.flatMap(({node,source})=>{
        const matched=recoverWindows(windows,first,source,viewer,recordedPhases,seen);
        return matched?[{node,source,matched}]:[];
      });
      const last=matches.at(-1);
      if(!last)return {from:from.sourceLine,to:limit.sourceLine,reason:'推进后的局面与后续录像不一致。'};
      return {from:from.sourceLine,to:last.node.sourceLine,at:boundary(last.node),t:last.node.t,game:from.game,
        recovered:last.matched.recovered,matches};
    }catch(error){
      signal?.throwIfAborted();return {from:from.sourceLine,to:limit.sourceLine,reason:error.message};
    }finally{onProgress(++checked,gaps.length);}
  },signal,workers);
  const insert=new Map(),added=[],routed=new Map(),seenPhases=new Set(recordedPhases),seenWindows=new Set();
  let index=0;
  for(const gap of runs){
    if(!gap.recovered)continue;
    const list=insert.get(gap.at)||[];
    for(const item of gap.recovered){
      if(item.kind==='phase'){
        const key=item.turn+':'+item.phase;
        if(!seenPhases.has(key))list.push({k:'priority-phase',t:gap.t,game:gap.game,...item});
        seenPhases.add(key);continue;
      }
      const {state,...node}=item;
      if(seenWindows.has(node.stateKey))continue;
      seenWindows.add(node.stateKey);
      const id=rows.length+index++*gameCount+gap.game;
      const recovery={from:gap.from,to:gap.to,steps:node.prefix.length};
      added.push({...node,recovery,sourceLine:id,anchorLine:gap.at,t:gap.t,game:gap.game,cardName:'补全的优先权'});
      list.push({k:'priority-window',t:gap.t,game:gap.game,turn:node.turn,phase:node.phase,
        priorityPlayerId:node.priorityPlayerId,sourceLine:id,state,recovery});
    }
    for(const {node,source,matched} of gap.matches){
      const endpoint=source.baseline,prefix=matched.endPrefix;
      if(!routed.has(node.sourceLine)&&node.kind!=='play'&&(endpoint.stack.some(s=>s.isAbility||s.isTrigger)||
        endpoint.players.some(p=>p.battlefield.some(c=>c.isBlocking))))
        routed.set(node.sourceLine,{recovery:{from:gap.from,to:node.sourceLine,steps:prefix.length},prefix,stateKey:stateKey(endpoint,viewer)});
    }
    if(list.length)insert.set(gap.at,list);
  }
  const completed=rows.flatMap((raw,i)=>[...(insert.get(i+1)||[]).map(r=>JSON.stringify(r)),
    ...(['priority-phase','priority-window'].includes(records[i]?.k)?[]:[raw])]).join('\n');
  return {text:completed,added,routed,gaps:runs.map(({from,to,recovered,reason,matches})=>({from,to,
    windows:recovered?.filter(r=>r.kind==='recovered').length??0,matched:matches?.map(m=>m.node.sourceLine),reason}))};
}

module.exports={completePriorityReplay,stateKey,recoverWindows};
