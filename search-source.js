'use strict';
const R=require('./replay'),Scenario=require('./scenario');
const clone=x=>JSON.parse(JSON.stringify(x));
const ZONES=['hand','battlefield','graveyard','exile','commandZone'];
const cards=s=>s.players.flatMap(p=>ZONES.flatMap(z=>p[z]||[])).concat((s.stack||[]).map(s=>s.sourceCard).filter(Boolean));
const phaseAliases={PRECOMBAT_MAIN:'MAIN1',POSTCOMBAT_MAIN:'MAIN2',COMBAT_BEGIN:'BEGIN_COMBAT',
  COMBAT_DECLARE_ATTACKERS:'DECLARE_ATTACKERS',COMBAT_DECLARE_BLOCKERS:'DECLARE_BLOCKERS',
  COMBAT_FIRST_STRIKE_DAMAGE:'FIRST_STRIKE_DAMAGE',COMBAT_END:'END_COMBAT',END_OF_TURN:'END_STEP'};
const steps=new Set(['UNTAP','UPKEEP','DRAW','MAIN1','BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS',
  'FIRST_STRIKE_DAMAGE','COMBAT_DAMAGE','END_COMBAT','MAIN2','END_STEP','CLEANUP']);
const exactPhase=state=>{
  const step=phaseAliases[state.step]||state.step;
  return steps.has(step)?step:phaseAliases[state.phase]||state.phase;
};
function sourceAt(text,line){
  const source=Scenario.sourceAt(text,line),prefix=source.rows.filter(x=>x.line<source.anchor.line);
  const selected=source.rows.find(x=>x.line===line)?.row;
  const priorityWindow=['key','diff'].includes(selected?.k)||selected?.action?.type==='PASS_PRIORITY';
  const generated=Scenario.isLabReplay(source.header)||source.header.branchMeta?.sourceKind==='description';
  const start=prefix.findLastIndex(x=>x.row.k==='chapter'&&x.row.edge==='start');
  const current=prefix.slice(1),startLine=start>=0?prefix[start].line:0;let state=null,turn=0,phase='',active='',firstPriority='',pending=[];
  const snapshots=new Map(),known=new Map(),faces=new Map(),cardHistory={},turnHistory=new Map(),initialDeckSizes={},uncertainties=[],resolved=[],casts=[],knownTop={'0':[],'1':[]};
  const recordFor=n=>{if(!turnHistory.has(n))turnHistory.set(n,[{},{}]);return turnHistory.get(n);};
  const playerHistory=(n,id)=>{const h=recordFor(n);return h[Number(id)]||(h[Number(id)]={});};
  function countDraw(moves){for(const m of moves){const h=playerHistory(turn,m.id);h.numDrawnThisTurn=(h.numDrawnThisTurn||0)+1;if((m.phase??phase)==='DRAW')h.numDrawnThisDrawStep=(h.numDrawnThisDrawStep||0)+1;}}
  function flushDefault(){
    if(!pending.length)return;
    if((pending[0].phase??phase)==='DRAW'&&pending.length===1&&String(pending[0].id)===String(active)&&(playerHistory(turn,active).numDrawnThisTurn||0)===0)countDraw(pending);
    else uncertainties.push({turn,message:'无法确定第 '+pending[0].line+' 行的 Library → Hand 是抓牌还是找牌。'});pending=[];
  }
  for(const x of current){
    const row=x.row,e=row.event;
    if(row.k==='key')state=row.state;else if(row.k==='diff')state=R.patch(state,row.patch);
    if(x.line<startLine)continue;
    if(state){
      if(generated)snapshots.set(Number(state.turnNumber),state);
      for(const p of state.players){if(initialDeckSizes[p.id]==null&&p.librarySize!=null)initialDeckSizes[p.id]=p.librarySize+(p.handSize||0)+['battlefield','graveyard','exile'].reduce((n,z)=>n+(p[z]||[]).filter(c=>!c.isToken).length,0)+(state.stack||[]).filter(s=>!s.isAbility&&!s.isTrigger&&String(s.sourceCard?.ownerId)===String(p.id)).length;}
      const visible=cards(state),visibleIds=new Set(visible.filter(c=>!c.faceDown&&c.name!=='Hidden card').map(c=>String(c.id)));
      const options=state.pendingAction?.contextType==='sideboard'?[]:(state.pendingAction?.cardOptions||[]).filter(c=>!c.stackKind&&!visibleIds.has(String(c.id))&&!known.has(String(c.id)));
      for(const original of visible.concat(options))if(original.id!=null&&original.name&&original.name!=='Hidden card'&&!original.faceDown&&original.zone!=='Player'&&!original.types?.includes('Player')&&!(original.zone==='Command'&&!original.isCommander&&!original.isCompanion)){
        const c=clone(original);if(c.ownerId==null&&c.ownerName)c.ownerId=state.players.find(p=>p.name===c.ownerName)?.id;
        if(c.ownerId==null&&state.pendingAction?.cardOptions?.some(o=>o.id===c.id))c.ownerId=String(source.header.seat);
        const front=c.isTransformed||c.isBackFace?c.alternateFaceName:c.name;
        known.set(String(c.id),c);if(front)faces.set(String(c.id),front.split(' // ')[0]);
      }
    }
    if(row.k==='action'&&row.action.type==='ARRANGE_CARDS'&&(state?.pendingAction?.contextType==='library_top'||state?.pendingAction?.sourceCardName==='Brainstorm')){
      const id=String(source.header.seat),ordered=row.action.orderedCards.map(Number),brainstorm=state.pendingAction.sourceCardName==='Brainstorm';
      knownTop[id]=ordered.concat(brainstorm?knownTop[id]:knownTop[id].slice(ordered.length));
    }
    if(!e)continue;
    if(e.type==='TURN_BEGAN'){
      flushDefault();turn=Number(e.turnNumber)||turn+1;active=String(e.playerIndex);firstPriority=active;phase='';
      if(state)for(const p of state.players)playerHistory(turn,p.id).lifeStartedThisTurn=p.life;
    }
    if(e.type==='TURN_PHASE'){flushDefault();phase=e.phase;active=String(e.playerIndex);firstPriority=active;}
    if(e.type==='SPELL_CAST'){flushDefault();casts.push({turn,playerId:String(e.playerIndex),cardId:e.cardId,cardName:e.cardName});const h=playerHistory(turn,e.playerIndex);h.spellsCastThisTurn=(h.spellsCastThisTurn||0)+1;firstPriority=String(e.playerIndex);}
    if(e.type==='ABILITY_ACTIVATED'){
      flushDefault();
      firstPriority=String(e.playerIndex);const c=known.get(String(e.cardId));
      const h=cardHistory[e.cardId]||(cardHistory[e.cardId]={});
      if(c?.types?.includes('Planeswalker')){if(h.activationTurn!==turn){h.activationTurn=turn;h.planeswalkerActivations=0;}h.planeswalkerActivations++;}
    }
    if(e.type==='LAND_PLAYED'){const h=playerHistory(turn,e.playerIndex);h.landsPlayedThisTurn=(h.landsPlayedThisTurn||0)+1;firstPriority=String(e.playerIndex);}
    if(e.type==='PLAYER_LIFE_CHANGED'){
      const h=playerHistory(turn,e.playerIndex),delta=Number(e.newValue)-Number(e.oldValue);
      if(delta<0)h.lifeLostThisTurn=(h.lifeLostThisTurn||0)-delta;else h.lifeGainedThisTurn=(h.lifeGainedThisTurn||0)+delta;
    }
    if(e.type==='CARD_ZONE_CHANGE'){
      if(e.cardId!=null){const h=cardHistory[e.cardId]||(cardHistory[e.cardId]={});h.turnInZone=turn;h.zone=e.toZone;}
      // Opening hands and mulligan redraws happen before the first turn and do not count as in-turn draws.
      if(e.fromZone==='Library'&&e.toZone==='Hand'&&(turn>0||Number(state?.turnNumber)>0)){
        const id=String(e.zoneOwnerIndex);if(e.cardId==null||String(knownTop[id]?.[0])===String(e.cardId))knownTop[id]?.shift();
        pending.push({line:x.line,id,phase:generated?state?.phase:undefined});
      }
    }
    if(e.type==='SHUFFLE'){const id=String(e.playerIndex??e.zoneOwnerIndex??active);knownTop[id]=[];}
    if(e.type==='SPELL_RESOLVED'){
      if(priorityWindow)firstPriority=active;
      if(pending.length){
        if(/\bdraw(?:s|ing)?\b/i.test(e.message||''))countDraw(pending);
        else if(!/\bsearch|\blook|\breveal|\bput\b.*\bhand\b/i.test(e.message||''))uncertainties.push({turn,message:'无法核对 '+(e.cardName||'异能')+' 结算时的抓牌历史。'});
        else for(const m of pending)knownTop[m.id]=[];
        pending=[];
      }
      resolved.push({turn,playerId:active,...e});
    }
  }
  flushDefault();
  const now=Number(source.baseline.turnNumber),history=source.baseline.players.map(p=>{
    const h=playerHistory(now,p.id),last=playerHistory(now-1,p.id),prior=snapshots.get(now-1)?.players.find(q=>q.id===p.id);
    const drawn=(generated?p.drawnThisTurn:undefined)??h.numDrawnThisTurn??0;
    return{numDrawnThisTurn:drawn,numDrawnThisDrawStep:h.numDrawnThisDrawStep||0,numExtraDrawnThisTurn:Math.max(0,drawn-(String(p.id)===String(source.baseline.activePlayerId)?1:0)),numDrawnLastTurn:prior?.drawnThisTurn??last.numDrawnThisTurn??0,
      spellsCastThisTurn:h.spellsCastThisTurn||0,spellsCastLastTurn:last.spellsCastThisTurn||0,spellsCastThisGame:casts.filter(c=>c.playerId===String(p.id)).length,landsPlayedThisTurn:(generated?p.landsPlayedThisTurn:undefined)??h.landsPlayedThisTurn??0,lifeStartedThisTurn:h.lifeStartedThisTurn??p.life,lifeLostThisTurn:h.lifeLostThisTurn||0,lifeGainedThisTurn:h.lifeGainedThisTurn||0};
  });
  for(const h of Object.values(cardHistory))if(h.activationTurn!==now)h.planeswalkerActivations=0;
  source.known=[...known.values()];source.faces=Object.fromEntries(faces);source.historyCounters=history;source.cardHistory=cardHistory;source.initialDeckSizes=initialDeckSizes;
  source.firstPriorityId=Number(source.inferredAction&&source.baseline.stack.length?source.baseline.stack[0].controllerId:firstPriority||source.baseline.activePlayerId);source.historyUncertainties=uncertainties.filter(e=>{
    if(e.turn<now-1)return false;
    const observed=e.turn===now?source.baseline:snapshots.get(e.turn);
    return !generated||!observed?.players.every(p=>Number.isInteger(p.drawnThisTurn));
  }).map(e=>e.message);
  source.recentResolutions=resolved.filter(e=>e.turn>=now-1);source.activeUnrestoredEffects=source.recentResolutions.filter(e=>/until your next turn/i.test(e.message||'')&&(e.turn===now||String(known.get(String(e.cardId))?.controllerId)!==String(source.baseline.activePlayerId)));
  source.knownTop=knownTop;source.spellHistory=casts.filter(c=>c.turn>=now-1);return source;
}
function candidates(text){
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((raw,i)=>({raw,line:i+1})).filter(x=>x.raw.trim()).map(x=>({...x,row:JSON.parse(x.raw)}));
  let state=null,game=1;const result=[],inferred=Scenario.labAnchors(rows),resolving=new Map(),main1Passes=new Map();
  for(const x of rows.slice(1)){
    if(x.row.k==='key')state=x.row.state;else if(x.row.k==='diff')state=R.patch(state,x.row.patch);
    if(x.row.k==='chapter'&&x.row.edge==='start'){game=x.row.game;resolving.clear();main1Passes.clear();}
    if(x.row.k==='action'&&x.row.action.type==='PASS_PRIORITY'&&state?.status==='ACTIVE'&&state.phase==='MAIN1'&&
      !state.stack.length&&String(state.activePlayerId)===String(rows[0].row.seat)&&String(state.priorityPlayerId)===String(rows[0].row.seat)&&
      !main1Passes.has(Number(state.turnNumber)))main1Passes.set(Number(state.turnNumber),x.line);
    if(x.row.k==='event'&&['SPELL_CAST','ABILITY_ACTIVATED','LAND_PLAYED'].includes(x.row.event.type)&&String(x.row.event.playerIndex)===String(rows[0].row.seat)){
      const match=result.findLast(n=>!n.eventLine&&String(n.cardId)===String(x.row.event.cardId)&&x.row.t>=n.t&&x.row.t-n.t<15000);
      if(match){match.anchorLine=match.sourceLine;match.sourceLine=x.line;match.eventLine=x.line;match.event=x.row.event;
        if(['Show and Tell','Stock Up'].includes(match.cardName))resolving.set(String(match.cardId),match);
        if(match.cardName==='Show and Tell'&&match.phase==='MAIN2')match.earlierLine=main1Passes.get(match.turn);
      }
    }
    const derived=inferred.get(x.line);
    if(derived){result.push(candidate(derived.state,rows[0].row.seat,{sourceLine:x.line,eventLine:x.line,anchorLine:derived.line,t:derived.t,game,cardId:derived.card.id,cardName:derived.card.name,event:x.row.event}));}
    if(x.row.k==='action'&&['CHOOSE_CARDS','CHOOSE_TARGETS'].includes(x.row.action.type)&&state?.pendingAction?.contextType==='effect'){
      const prompt=state.pendingAction,stack=state.stack.find(s=>s.sourceCard?.name===prompt.sourceCardName);
      const cast=resolving.get(String(stack?.sourceCard?.id));
      const picked=x.row.action.targets||x.row.action.orderedCards;
      if(cast&&!cast.choice&&cast.cardName===prompt.sourceCardName&&picked?.length&&
        (cast.cardName==='Stock Up'?picked.length===2&&prompt.cardOptions?.length===5:picked.length===1)&&
        picked.every(id=>prompt.cardOptions?.some(c=>String(c.id)===String(id)))){
        cast.choice={line:x.line,name:cast.cardName,sourceId:cast.cardId,picked,options:prompt.cardOptions.map(c=>({id:c.id,name:c.name}))};
      }
    }
    if(x.row.k!=='action'||x.row.action.type!=='PLAY_CARD'||!state||state.status!=='ACTIVE'||state.sideboarding)continue;
    const id=x.row.action.cardId,card=cards(state).find(c=>String(c.id)===String(id));if(!card)continue;
    result.push(candidate(state,rows[0].row.seat,{sourceLine:x.line,t:x.row.t,game,cardId:id,cardName:card.name}));
  }
  return result.filter(n=>n.eventLine);
}
function candidate(state,seat,node){
  return {...node,turn:Number(state.turnNumber),phase:state.phase,
    activePlayerId:state.activePlayerId,priorityPlayerId:state.priorityPlayerId,stack:state.stack.map(s=>s.name||s.description),
    players:state.players.map(p=>({id:p.id,life:p.life,handSize:p.handSize,librarySize:p.librarySize,hand:String(p.id)===String(seat)?p.hand.map(c=>c.name):[],battlefield:p.battlefield.map(c=>({id:c.id,name:c.name,tapped:c.tapped,counters:c.counters,chosenMarks:c.chosenMarks||[]}))}))};
}

function priorityCandidates(text){
  const played=candidates(text);
  const byAnchor=new Map(played.map(n=>[n.anchorLine,n]));
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((raw,index)=>({raw,line:index+1}))
    .filter(x=>x.raw.trim()).map(x=>({...x,row:JSON.parse(x.raw)}));
  const seat=String(rows[0].row.seat),prompts=new Map(),unmatched=new Map();
  let game=1,state=null;
  function promptKey(){
    if(!state||state.status!=='ACTIVE'||state.sideboarding||Number(state.turnNumber)<1)return null;
    const actor=String(state.priorityPlayerId),phase=exactPhase(state);
    if(!['0','1'].includes(actor)||['UNTAP','UNKNOWN','BEGINNING','COMBAT','ENDING'].includes(phase))return null;
    const version=Number(actor===seat?state.pendingAction?.promptVersion??state.priorityPromptVersion:state.priorityPromptVersion);
    if(!version||actor===seat&&state.pendingAction?.type!=='PRIORITY'||phase==='CLEANUP'&&state.pendingAction?.type!=='PRIORITY')return null;
    return [game,state.turnNumber,phase,actor,version].join(':');
  }
  for(const {line,row} of rows.slice(1)){
    if(row.k==='chapter'&&row.edge==='start')game=row.game;
    if(row.k==='key'||row.k==='diff'){
      state=row.k==='key'?row.state:state&&R.patch(state,row.patch);
      const key=promptKey();
      const observed=String(state?.priorityPlayerId)===seat||row.k==='key'||Object.hasOwn(row.patch?.o||{},'priorityPromptVersion');
      if(key&&observed&&!prompts.has(key))prompts.set(key,{sourceLine:line,t:row.t,game,turn:Number(state.turnNumber),
        phase:exactPhase(state),priorityPlayerId:String(state.priorityPlayerId),cardName:'取得优先权',kind:'priority'});
      continue;
    }
    if(row.k!=='action'||!state||state.status!=='ACTIVE'||state.sideboarding||String(state.priorityPlayerId)!==seat)continue;
    const playedNode=byAnchor.get(line);
    const pass=row.action.type==='PASS_PRIORITY';
    if(!playedNode&&!pass)continue;
    const node=playedNode?{...playedNode,kind:'play',phase:exactPhase(state)}:
      {sourceLine:line,anchorLine:line,t:row.t,game,turn:Number(state.turnNumber),phase:exactPhase(state),
        priorityPlayerId:seat,cardName:'让过优先权',kind:'pass'};
    const key=promptKey();
    if(key&&prompts.has(key))prompts.set(key,node);
    else unmatched.set(node.sourceLine,node);
  }
  const matchedLines=new Set([...prompts.values()].map(n=>n.sourceLine));
  for(const node of played)if(!matchedLines.has(node.sourceLine)&&!unmatched.has(node.sourceLine))
    unmatched.set(node.sourceLine,{...node,kind:'play'});
  return [...prompts.values(),...unmatched.values()].sort((a,b)=>a.sourceLine-b.sourceLine);
}

module.exports={sourceAt,candidates,priorityCandidates,exactPhase};
