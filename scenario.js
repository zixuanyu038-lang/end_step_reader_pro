'use strict';
// Deterministic state ledger for hypothetical games. This is intentionally NOT a full MTG rules engine.
const crypto=require('node:crypto'),R=require('./replay'),S=require('./studio-schema');
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const zones={hand:'Hand',battlefield:'Battlefield',graveyard:'Graveyard',exile:'Exile',library:'Library'};
const hidden=c=>c.faceDown||!c.name||c.name==='Hidden card';
const stateCards=s=>s.players.flatMap(p=>['hand','battlefield','graveyard','exile','commandZone'].flatMap(z=>p[z]||[])).concat((s.stack||[]).map(x=>x.sourceCard).filter(Boolean));
// Lab exports record engine events with state transitions, without client submissions.
const isLabReplay=header=>header.labMeta?.format==='legacy-energy-lab'&&header.labMeta.version===1;
function labAnchors(rows){
  const result=new Map(),header=rows[0].row;
  if(!isLabReplay(header))return result;
  let state=null,previous=null,stateRow=null,move=null;
  for(const x of rows.slice(1)){
    const r=x.row,e=r.event;
    if(r.k==='chapter'){move=null;previous=null;stateRow=null;if(r.edge==='start')state=null;}
    if(r.k==='key'||r.k==='diff'){previous=state;state=r.k==='key'?r.state:R.patch(state,r.patch);stateRow=x;}
    if(e?.type==='CARD_ZONE_CHANGE'&&e.cardId!=null&&['Stack','Battlefield'].includes(e.toZone)){
      const actor=String(e.playerIndex??e.zoneOwnerIndex??header.seat);
      const zone={Hand:'hand',Graveyard:'graveyard',Exile:'exile'}[e.fromZone];
      const from=s=>zone&&s?.players.find(p=>String(p.id)===actor)?.[zone]?.find(c=>String(c.id)===String(e.cardId));
      const stillBefore=!!from(state),before=stillBefore?state:stateRow?.row.t===r.t?previous:null;
      const anchor=stillBefore?x:stateRow;
      const card=from(before);
      move=card&&['Hand','Graveyard','Exile'].includes(e.fromZone)&&before.status==='ACTIVE'&&String(before.priorityPlayerId)===actor
        ?{line:anchor.line,t:anchor.row.t,state:before,card,actor,to:e.toZone,turn:before.turnNumber,phase:before.phase}:null;
    }
    if(e?.type==='TURN_BEGAN'||e?.type==='TURN_PHASE'||e?.type==='SPELL_RESOLVED')move=null;
    if(e?.type==='SPELL_CAST'||e?.type==='LAND_PLAYED'){
      if(move&&String(e.playerIndex)===move.actor&&move.actor===String(header.seat)&&String(e.cardId)===String(move.card.id)&&
        String(state.turnNumber)===String(move.turn)&&state.phase===move.phase&&(e.type==='SPELL_CAST'?'Stack':'Battlefield')===move.to){
        const stack=e.type==='SPELL_CAST'?state.stack.find(item=>String(item.sourceCard?.id)===String(e.cardId)):null;
        if(e.type==='LAND_PLAYED'||stack)result.set(x.line,{...move,kind:stack?'cast':'play_land',targets:stack?.targets});
      }
      move=null;
    }
  }
  return result;
}
function sourceAt(text,selectedLine){
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((raw,i)=>({raw,line:i+1})).filter(x=>x.raw.trim()).map(x=>({...x,row:JSON.parse(x.raw)}));
  const chosen=rows.find(x=>x.line===selectedLine);if(!chosen||!['event','action','key','diff'].includes(chosen.row.k))throw Error('分支必须指向原局中的操作或优先权快照。');
  const isSnapshot=['key','diff'].includes(chosen.row.k);
  let anchor=chosen;
  const inferred=labAnchors(rows).get(selectedLine);
  if(inferred)anchor=rows.find(x=>x.line===inferred.line);
  // A local submitted action is a more precise pre-cast anchor than a later server event.
  const e=chosen.row.event,own=String(e?.playerIndex)===String(rows[0].row.seat);
  if(!inferred&&own&&['SPELL_CAST','ABILITY_ACTIVATED','LAND_PLAYED'].includes(e?.type)){
    const candidates=rows.filter(x=>x.line<selectedLine&&x.row.k==='action'&&x.row.action.type==='PLAY_CARD'&&x.row.t<=chosen.row.t&&chosen.row.t-x.row.t<15000);
    const prior=candidates.at(-1);if(prior&&(e.cardId==null||String(prior.row.action.cardId)===String(e.cardId)))anchor=prior;
  }
  const boundary=anchor.line+(isSnapshot?1:0);
  let state=null,game=1;const known=new Map(),history=[];
  for(const x of rows.slice(1)){
    if(x.line>=boundary)break;
    if(x.row.k==='chapter'&&x.row.edge==='start')game=x.row.game;
    if(x.row.k==='key')state=x.row.state;else if(x.row.k==='diff')state=R.patch(state,x.row.patch);
    if(state)for(const c of stateCards(state).concat(state.pendingAction?.cardOptions||[],state.players.flatMap(p=>p.libraryTop||[])))if(!hidden(c))known.set(String(c.id),clone(c));
    if(x.row.k==='event')history.push({sourceLine:x.line,t:x.row.t,event:x.row.event});
  }
  if(inferred)state=inferred.state;
  let inferredAction=inferred?{kind:inferred.kind,cardId:inferred.card.id,targets:inferred.targets}:null;
  if(!inferredAction&&rows[0].row.branchMeta?.sourceKind==='description'&&anchor!==chosen&&e?.type==='SPELL_CAST'){
    let recorded=state;
    for(const x of rows){
      if(x.line<=anchor.line||x.line>=chosen.line)continue;
      if(x.row.k==='key')recorded=x.row.state;else if(x.row.k==='diff')recorded=R.patch(recorded,x.row.patch);
    }
    const stack=recorded?.stack.find(s=>String(s.sourceCard?.id)===String(e.cardId));
    if(stack)inferredAction={kind:'cast',cardId:e.cardId,targets:stack.targets};
  }
  if(!state||state.status!=='ACTIVE'||state.sideboarding)throw Error('该节点没有可恢复的进行中局面。');
  if(isSnapshot){
    const own=String(state.priorityPlayerId)===String(rows[0].row.seat);
    const reported=chosen.row.k==='key'||Object.hasOwn(chosen.row.patch?.o||{},'priorityPromptVersion');
    if(own&&state.pendingAction?.type!=='PRIORITY'||!own&&(!reported||!Number(state.priorityPromptVersion)))
      throw Error('这条快照没有记录该玩家的优先权。');
  }
  return{rows,header:rows[0].row,inferredAction,baseline:clone(state),game,known:[...known.values()],history,anchor:{line:boundary,selectedLine,t:anchor.row.t,game,turn:Number(state.turnNumber)||0},sha256:digest(text)};
}
function cleanCard(template,id,playerId,zone){return{...clone(template),id,ownerId:playerId,controllerId:playerId,zone:zones[zone],faceDown:false,tapped:false,isTapped:false,isToken:false,damage:0,counters:{},chosenMarks:[],stateNotes:[],attachedCards:[],hasSummoningSickness:zone==='battlefield',isAttacking:false,isBlocking:false,isPhasedOut:false};}
function initialization(plan){return{assumptions:plan.assumptions,hiddenHands:plan.hiddenHands,libraries:plan.libraries};}
async function compile(source,plan,catalog,{frozen=null}={}){
  S.validate(plan,S.branch);
  if(!plan.steps.length||plan.steps.length>500)throw Error('推荐对局需要 1–500 个步骤。');
  if(frozen&&digest(initialization(plan))!==digest(frozen))throw Error('修正只能改变动作，不能更换已经固定的隐藏牌和牌序假设。');
  const assumptions=new Map();for(const a of plan.assumptions){if(!a.id.trim()||assumptions.has(a.id)||!a.basis.trim())throw Error('假设编号重复或缺少依据。');assumptions.set(a.id,a);}
  const s=clone(source.baseline),libraries=new Map(),casts={},lands={};let t=source.anchor.t,seq=0,activeStep=0,complete=false,winnerId=null;
  s.pendingAction=null;s.priorityPromptVersion=0;if(s.clock){delete s.clock.runningSide;delete s.clock.runningSideDeadlineMs;}
  const owner=id=>{const p=s.players.find(x=>String(x.id)===String(id));if(!p)throw Error('玩家不存在：'+id);return p;};
  for(const a of plan.assumptions)if(!s.players.some(p=>String(p.id)===a.playerId))throw Error('假设所属玩家不存在。');
  const find=id=>{
    for(const p of s.players){for(const z of ['hand','battlefield','graveyard','exile']){const c=p[z]?.find(c=>String(c.id)===String(id));if(c)return{p,z,c};}const c=libraries.get(String(p.id))?.find(c=>String(c.id)===String(id));if(c)return{p,z:'library',c};}
    const stack=s.stack.find(x=>!x.isAbility&&String(x.sourceCard.id)===String(id));if(stack)return{p:owner(stack.controllerId),z:'stack',c:stack.sourceCard,stack};throw Error('牌不在任何可操作区域：'+id);
  };
  const requirement=(id,player)=>{const a=assumptions.get(id);if(!a||a.playerId!==String(player))throw Error('缺少与玩家相符的假设编号：'+id);};
  const handPlayers=new Set(),libraryPlayers=new Set();
  for(const h of plan.hiddenHands){
    const p=owner(h.playerId);if(handPlayers.has(h.playerId))throw Error('重复的隐藏手牌设定。');handPlayers.add(h.playerId);requirement(h.assumptionId,p.id);
    const slots=p.hand.filter(hidden);if(h.cards.length!==slots.length)throw Error(p.name+' 假设手牌数必须为 '+slots.length);
    for(let i=0;i<slots.length;i++){const c=await catalog.get(h.cards[i]);const index=p.hand.indexOf(slots[i]);p.hand[index]=cleanCard(c,slots[i].id,p.id,'hand');}
  }
  for(const p of s.players)if(p.hand.some(hidden))throw Error(p.name+' 的隐藏手牌尚未补全。');
  for(const l of plan.libraries){
    const p=owner(l.playerId);if(libraryPlayers.has(l.playerId))throw Error('重复的牌库设定。');libraryPlayers.add(l.playerId);requirement(l.assumptionId,p.id);
    if(l.cards.length!==p.librarySize)throw Error(p.name+' 假设牌库数量必须为 '+p.librarySize);
    const cards=[];for(const [i,item] of l.cards.entries()){
      const knownTop=p.libraryTop?.[i];if(knownTop&&!hidden(knownTop)&&(knownTop.name!==item.name||knownTop.id!==item.id))throw Error('不得改变已知牌库顶：'+knownTop.name);
      const known=source.known.find(c=>String(c.id)===String(item.id));if(known&&known.name!==item.name)throw Error('不得修改真实已知牌的身份：'+item.id);
      cards.push(cleanCard(await catalog.get(item.name),item.id,p.id,'library'));
    }libraries.set(String(p.id),cards);p.libraryTop=[];
  }
  for(const p of s.players)if(!libraries.has(String(p.id)))throw Error('需要每位玩家的完整假设牌库。');
  if(String(source.header.formatId||'').toLowerCase()==='legacy')for(const p of s.players){
    const counts=new Map();for(const c of ['hand','battlefield','graveyard','exile'].flatMap(z=>p[z]||[]).concat(libraries.get(String(p.id)),s.stack.filter(x=>!x.isAbility&&String(x.controllerId)===String(p.id)).map(x=>x.sourceCard))){if(c.isToken||c.supertypes?.includes('Basic')||/any number of cards named/i.test(c.oracleText||''))continue;counts.set(c.name,(counts.get(c.name)||0)+1);if(counts.get(c.name)>4)throw Error(p.name+' 的假设牌表超过四张同名非基本牌：'+c.name);}
  }
  // Reconstruct cast/land counters strictly from the source prefix.
  for(const {event:e} of source.history){if(e.type==='TURN_BEGAN'){for(const key of Object.keys(casts))delete casts[key];for(const key of Object.keys(lands))delete lands[key];}if(e.type==='SPELL_CAST')casts[String(e.playerIndex)]=(casts[String(e.playerIndex)]||0)+1;if(e.type==='LAND_PLAYED')lands[String(e.playerIndex)]=(lands[String(e.playerIndex)]||0)+1;}
  const prefix=source.rows.filter(x=>x.line>1&&x.line<source.anchor.line).map(x=>x.raw),records=[],trace=[];
  const header={...source.header,result:null,complete:false,games:source.game,branchMeta:{format:'endstep-codex-scenario',version:2,title:plan.title,sourceSha256:source.sha256,anchorLine:source.anchor.line,selectedLine:source.anchor.selectedLine,assumptions:plan.assumptions.map(a=>`[${a.id}] ${a.basis}`),verification:'state-ledger-only',simulationComplete:false,stop:{reason:'simulation',detail:plan.stopReason}}};
  let random=parseInt(digest(source.sha256+':'+source.anchor.line).slice(0,8),16)||1;
  const rng=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return(random>>>0)/4294967296;};
  const emit=e=>records.push({k:'event',t,event:{...e,gameId:s.gameId,sequenceNumber:-7000000000000000+seq++},at:Date.parse(source.header.recordedAt)+t});
  const note=message=>emit({type:'ADD_LOG',message});
  const key=()=>{s.sequenceNumber=(Number(s.sequenceNumber)||0)+1;records.push({k:'key',t,state:clone(s)});};
  const event=(type,p,extra={})=>emit({type,playerIndex:String(p.id),playerName:p.name,...extra});
  function invariant(){
    const seen=new Set();for(const p of s.players){
      if(!Number.isFinite(p.life)||Math.abs(p.life)>1e6)throw Error('生命总值无效。');
      if(p.handSize!==p.hand.length||p.librarySize!==libraries.get(String(p.id)).length)throw Error('手牌或牌库数量与区域不一致。');
      for(const c of ['hand','battlefield','graveyard','exile','commandZone'].flatMap(z=>p[z]||[]).concat(libraries.get(String(p.id)))){if(!Number.isSafeInteger(c.id)||seen.has(c.id))throw Error('牌 ID 缺失或重复：'+c.id);seen.add(c.id);}
      if(Object.values(p.manaPool||{}).some(n=>!Number.isInteger(n)||n<0))throw Error('法术力池为负数或无效。');
    }for(const x of s.stack){if(!x.isAbility){if(seen.has(x.sourceCard.id))throw Error('咒语同时存在于堆叠和其他区域。');seen.add(x.sourceCard.id);}}
  }
  function move(f,to){
    const from=zones[f.z]||'Stack';if(f.z==='stack')s.stack.splice(s.stack.indexOf(f.stack),1);else if(f.z==='library'){const lib=libraries.get(String(f.p.id));lib.splice(lib.indexOf(f.c),1);}else f.p[f.z].splice(f.p[f.z].indexOf(f.c),1);
    f.c.zone=zones[to];f.c.isAttacking=false;f.c.isBlocking=false;
    if(to==='library')libraries.get(String(f.p.id)).unshift(f.c);else f.p[to].push(f.c);
    if(to==='battlefield'){f.c.hasSummoningSickness=true;if(f.c.types.includes('Planeswalker')&&f.c.loyalty)f.c.counters.Loyalty=f.c.loyalty;}
    f.p.handSize=f.p.hand.length;f.p.librarySize=libraries.get(String(f.p.id)).length;
    event('CARD_ZONE_CHANGE',f.p,{cardId:f.c.id,cardName:f.c.name,fromZone:from,toZone:zones[to],zoneOwnerIndex:String(f.p.id)});
  }
  const board=()=>s.players.flatMap(p=>p.battlefield);
  function spend(p,c){
    const cost=c.manaCost||'';if(!/^(?:\{(?:\d+|[WUBRGC])\})*$/.test(cost)||!cost)throw Error('暂不支持该费用或替代费用：'+c.name+' '+cost);
    const colors={};let generic=0;for(const [,sym] of cost.matchAll(/\{([^}]+)\}/g)){if(/^\d+$/.test(sym))generic+=Number(sym);else colors[sym]=(colors[sym]||0)+1;}
    for(const c1 of board()){if(c1.name==='Disruptor Flute'&&c1.chosenMarks?.some(x=>x.value===c.name))generic+=3;if(c1.name==='Damping Sphere')generic+=casts[String(p.id)]||0;}
    const total=generic+Object.values(colors).reduce((a,b)=>a+b,0);if(board().some(c=>c.name==='Trinisphere'&&!c.tapped))generic+=Math.max(0,3-total);
    p.manaPool||={};for(const [color,count]of Object.entries(colors)){if((p.manaPool[color]||0)<count)throw Error(c.name+' 缺少 '+color+' 法术力。');p.manaPool[color]-=count;}
    for(const color of Object.keys(p.manaPool)){const n=Math.min(generic,p.manaPool[color]);p.manaPool[color]-=n;generic-=n;}if(generic)throw Error(c.name+' 法术力总量不足。');
  }
  function doCommand(c,actor){
    if(complete)throw Error('终局后仍有动作。');
    if(c.op==='phase'){
      if(s.stack.length)throw Error('堆叠非空时不能跳阶段。');const next=S.phases.indexOf(c.phase),old=S.phases.indexOf(s.phase);if(next<old)throw Error('同回合内阶段不能倒退。');s.phase=c.phase;s.step=c.phase;s.priorityPlayerId=s.activePlayerId;for(const p of s.players)p.manaPool={};event('TURN_PHASE',owner(s.activePlayerId),{phase:c.phase});
    }else if(c.op==='next_turn'){
      if(!['END_STEP','CLEANUP'].includes(s.phase)||s.stack.length||String(s.activePlayerId)===c.playerId)throw Error('下一回合必须从结束阶段或清除步骤、空堆叠切换到另一玩家。');
      const p=owner(c.playerId);s.turnNumber=String(Number(s.turnNumber)+1);s.activePlayerId=p.id;s.priorityPlayerId=p.id;s.phase='UNTAP';s.step='UNTAP';for(const p1 of s.players){p1.manaPool={};for(const card of p1.battlefield){card.damage=0;card.isAttacking=false;card.isBlocking=false;if(p1===p){card.tapped=false;card.isTapped=false;card.hasSummoningSickness=false;}}}for(const key of Object.keys(casts))delete casts[key];for(const key of Object.keys(lands))delete lands[key];event('TURN_BEGAN',p,{turnNumber:Number(s.turnNumber)});event('TURN_PHASE',p,{phase:'UNTAP'});
    }else if(c.op==='draw'){
      const p=owner(c.playerId);if(c.count<1||c.count>30)throw Error('抓牌数量无效。');const lib=libraries.get(String(p.id));
      for(let i=0;i<c.count;i++){if(!lib.length){p._scenarioDecked=true;break;}move(find(lib[0].id),'hand');}
    }else if(c.op==='shuffle'){
      const p=owner(c.playerId),lib=libraries.get(String(p.id));for(let i=lib.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[lib[i],lib[j]]=[lib[j],lib[i]];}event('SHUFFLE',p,{message:p.name+' 在假设场景中洗牌。'});
    }else if(c.op==='mana'){
      const f=find(c.cardId);if(f.z!=='battlefield'||f.p!==actor||f.c.tapped)throw Error('产费来源不在己方战场或已经横置。');
      let colors=f.c.subtypes?.map(t=>({Plains:'W',Island:'U',Swamp:'B',Mountain:'R',Forest:'G'})[t]).filter(Boolean)||[],amount=1;
      if(f.c.name==='Ancient Tomb'){colors=['C'];amount=2;}
      else if(["Urza's Tower","Urza's Mine","Urza's Power Plant"].includes(f.c.name)){colors=['C'];amount=["Urza's Tower","Urza's Mine","Urza's Power Plant"].every(n=>f.p.battlefield.some(x=>x.name===n))?(f.c.name==="Urza's Tower"?3:2):1;}
      else if(f.c.name==='Cloudpost'){colors=['C'];amount=board().filter(x=>x.subtypes?.includes('Locus')||x.name==='Planar Nexus').length;}
      else if(!colors.length){colors=[...(f.c.oracleText||'').matchAll(/Add \{([WUBRGC])\}/g)].map(m=>m[1]);if(/mana of any color/.test(f.c.oracleText||''))colors=['W','U','B','R','G'];}
      const moon=board().some(x=>x.name==='Blood Moon'||x.name==='Magus of the Moon')&&f.c.types.includes('Land')&&!f.c.supertypes?.includes('Basic');
      if(moon){colors=['R'];amount=1;}
      if(amount>1&&board().some(x=>x.name==='Damping Sphere')&&f.c.types.includes('Land')){colors=['C'];amount=1;}
      if(c.amount!==amount||!colors.includes(c.color))throw Error(f.c.name+' 不能按指定数量/颜色产费。');
      f.c.tapped=true;f.c.isTapped=true;actor.manaPool||={};actor.manaPool[c.color]=(actor.manaPool[c.color]||0)+amount;
      if(f.c.name==='Ancient Tomb'&&!moon){actor.life-=2;event('PLAYER_LIFE_CHANGED',actor,{amount:-2,message:'Ancient Tomb 造成 2 点伤害。'});}event('MANA_LOG',actor,{message:f.c.name+'：'+amount+' '+c.color});
    }else if(c.op==='play_land'||c.op==='cast'){
      const f=find(c.cardId);if(f.p!==actor||f.z!=='hand')throw Error('使用的牌不在行动玩家手牌。');
      const main=String(s.activePlayerId)===String(actor.id)&&['MAIN1','MAIN2'].includes(s.phase)&&!s.stack.length;
      if(c.op==='play_land'){
        if(!main||!f.c.types.includes('Land')||lands[String(actor.id)])throw Error('下地时机、类型或本回合次数不合法。');move(f,'battlefield');lands[String(actor.id)]=1;event('LAND_PLAYED',actor,{cardName:f.c.name,cardId:f.c.id});
      }else{
        if(f.c.types.includes('Land')||(!main&&!f.c.types.includes('Instant')&&!f.c.keywords?.includes('Flash')))throw Error('该牌当前不能施放。');spend(actor,f.c);actor.hand.splice(actor.hand.indexOf(f.c),1);actor.handSize=actor.hand.length;f.c.zone='Stack';s.stack.unshift({sourceCard:f.c,controllerId:actor.id,isAbility:false,isTrigger:false,targets:c.targets,modes:c.modes,stackTargetId:3000000000+seq});casts[String(actor.id)]=(casts[String(actor.id)]||0)+1;event('SPELL_CAST',actor,{cardName:f.c.name,cardId:f.c.id});
      }
    }else if(c.op==='activate'||c.op==='trigger'){
      const f=find(c.cardId);if(f.p!==actor||!['battlefield','graveyard'].includes(f.z))throw Error('异能来源区域或控制权无效。');
      if(c.op==='activate'&&board().some(x=>['Pithing Needle','Disruptor Flute','Petrified Hamlet'].includes(x.name)&&x.chosenMarks?.some(m=>m.value===f.c.name)))throw Error('命名锁件禁止该非产费异能。');
      s.stack.unshift({sourceCard:clone(f.c),controllerId:actor.id,isAbility:true,isTrigger:c.op==='trigger',abilityDescription:c.text,targets:[],stackTargetId:3000000000+seq});event(c.op==='trigger'?'TRIGGER_FIRED':'ABILITY_ACTIVATED',actor,{cardName:f.c.name,cardId:f.c.id,message:c.text});
    }else if(c.op==='resolve'){
      const item=s.stack[0];if(!item)throw Error('没有可结算的堆叠对象。');const p=owner(item.controllerId);
      if(item.isAbility)s.stack.shift();else move(find(item.sourceCard.id),item.sourceCard.types.some(t=>['Instant','Sorcery'].includes(t))?'graveyard':'battlefield');
      if(item.isAbility)note('[CODEX 异能结算] '+item.sourceCard.name+'：'+item.abilityDescription);else event('SPELL_RESOLVED',p,{cardName:item.sourceCard.name,cardId:item.sourceCard.id});
    }else if(c.op==='move'){move(find(c.cardId),c.to);}
    else if(c.op==='life'){const p=owner(c.playerId);if(Math.abs(c.delta)>10000)throw Error('生命变化过大。');p.life+=c.delta;event('PLAYER_LIFE_CHANGED',p,{amount:c.delta});}
    else if(c.op==='tap'){const f=find(c.cardId);if(f.z!=='battlefield')throw Error('只能横置/重置战场永久物。');f.c.tapped=c.tapped;f.c.isTapped=c.tapped;}
    else if(c.op==='counters'){const f=find(c.cardId);f.c.counters||={};const count=(f.c.counters[c.name]||0)+c.delta;if(count<0)throw Error('指示物数量为负。');f.c.counters[c.name]=count;event('CARD_COUNTERS',f.p,{cardId:f.c.id,cardName:f.c.name,counterType:c.name,amount:c.delta});}
    else if(c.op==='damage'){
      const f=find(c.cardId);if(f.z!=='battlefield'||!f.c.types.includes('Creature')||c.amount<0)throw Error('伤害目标或数量无效。');f.c.damage=(f.c.damage||0)+c.amount;
      if(f.c.toughness>0&&f.c.damage>=f.c.toughness&&!f.c.keywords?.includes('Indestructible'))move(f,'graveyard');
    }else if(c.op==='transform'){
      const f=find(c.cardId);if(f.c.alternateFaceName!==c.name)throw Error('转化名称不是该牌背面。');[f.c.name,f.c.alternateFaceName]=[f.c.alternateFaceName,f.c.name];[f.c.oracleText,f.c.alternateOracleText]=[f.c.alternateOracleText,f.c.oracleText];f.c.isTransformed=!f.c.isTransformed;
      if(c.name==='Tamiyo, Seasoned Scholar'){f.c.types=['Planeswalker'];f.c.subtypes=['Tamiyo'];f.c.counters={Loyalty:2};}
    }else if(c.op==='choose_name'){const f=find(c.cardId);f.c.chosenMarks=[{kind:'NAME',value:c.name}];f.c.stateNotes=[{label:'Named card',value:c.name,cardRefs:[{name:c.name}]}];}
    else if(c.op==='token'){
      try{find(c.cardId);throw Error('衍生物 ID 已使用。');}catch(e){if(!e.message.startsWith('牌不在'))throw e;}
      const p=owner(c.playerId);p.battlefield.push({...cleanCard({name:c.name,power:c.power,toughness:c.toughness,types:c.types,keywords:c.keywords,subtypes:[],manaCost:'',counters:{}},c.cardId,p.id,'battlefield'),isToken:true});event('TOKEN_CREATED',p,{cardName:c.name,amount:1});
    }else if(c.op==='attack'){
      if(String(s.activePlayerId)!==String(actor.id)||s.phase!=='DECLARE_ATTACKERS')throw Error('不是该玩家的宣攻步骤。');if(new Set(c.cardIds).size!==c.cardIds.length)throw Error('攻击者重复。');
      for(const id of c.cardIds){const f=find(id);if(f.p!==actor||f.z!=='battlefield'||!f.c.types.includes('Creature')||f.c.tapped||(f.c.hasSummoningSickness&&!f.c.keywords?.includes('Haste')))throw Error('攻击者不合法。');f.c.isAttacking=true;if(!f.c.keywords?.includes('Vigilance')){f.c.tapped=true;f.c.isTapped=true;}}event('ATTACKERS_DECLARED',actor,{amount:c.cardIds.length,cardNames:c.cardIds.map(id=>find(id).c.name)});
    }else if(c.op==='block'){
      const f=find(c.blockerId),a=find(c.attackerId);if(s.phase!=='DECLARE_BLOCKERS'||f.p!==actor||f.z!=='battlefield'||f.c.tapped||!f.c.types.includes('Creature')||!a.c.isAttacking||a.p===f.p)throw Error('阻挡者或攻击者不合法。');
      if(a.c.keywords?.includes('Flying')&&!f.c.keywords?.some(k=>['Flying','Reach'].includes(k)))throw Error('不能阻挡飞行生物。');f.c.isBlocking=true;event('BLOCKERS_DECLARED',actor,{amount:1});
    }else if(c.op==='concede'){owner(c.playerId)._scenarioConceded=true;}
    else if(c.op==='finish'){
      const losers=s.players.filter(p=>p.life<=0||p._scenarioDecked||p._scenarioConceded);if(losers.length!==1)throw Error('尚无唯一败者，不能凭空指定赛果。');const win=s.players.find(p=>p!==losers[0]);winnerId=win.id;s.status='COMPLETE';s.winnerId=win.id;complete=true;event('GAME_OUTCOME',win,{endReason:losers[0]._scenarioConceded?'CONCEDE':'SCENARIO',message:'基于假设的推演结果，非真实对局赛果。'});
    }else throw Error('未知指令：'+c.op);
  }
  invariant();key();note('[CODEX 假设推演] '+plan.title+'\n'+plan.summary+'\n以下牌序、隐藏手牌和后续是明确假设；状态校验不等于完整规则引擎验证。');
  for(const a of plan.assumptions)note(`[CODEX 假设 ${a.id}] ${a.basis}`);
  for(const h of plan.hiddenHands)note(`[CODEX 假设手牌 · ${h.assumptionId}] ${owner(h.playerId).name}：${h.cards.join(' / ')}。这是推测，不是原局公开信息。`);
  try{
    for(const [index,step]of plan.steps.entries()){
      activeStep=index+1;const actor=owner(step.actorId);if(!step.rule.trim()||!step.explanation.trim()||!step.commands.length)throw Error('每步须有规则依据、解释和至少一个指令。');
      for(const ref of step.assumptionRefs)if(!assumptions.has(ref))throw Error('步骤引用了不存在的假设：'+ref);
      if(!step.assumptionRefs.length)throw Error('完整假设推演中的步骤必须引用相关假设，不能掩盖未知信息。');
      t+=2200;for(const c of step.commands)doCommand(c,actor);invariant();key();
      note(`[CODEX 推演步骤 ${index+1} · ${step.assumptionRefs.join(', ')}] ${step.label}\n${step.explanation}\n规则依据：${step.rule}`);
      trace.push({step:index+1,turn:Number(s.turnNumber),phase:s.phase,actorId:step.actorId,life:s.players.map(p=>[p.id,p.life]),hand:s.players.map(p=>[p.id,p.hand.map(c=>[c.id,c.name])]),battlefield:s.players.map(p=>[p.id,p.battlefield.map(c=>[c.id,c.name,c.tapped,c.damage,c.counters])]),libraryTop:s.players.map(p=>[p.id,libraries.get(String(p.id)).slice(0,5).map(c=>[c.id,c.name])]),stack:s.stack.map(x=>x.sourceCard.name)});
    }
    if(!complete)throw Error('路线尚未推演到本局终局：'+plan.stopReason);
    header.branchMeta.simulationComplete=true;header.branchMeta.hypotheticalWinnerId=String(winnerId);header.branchMeta.stop={reason:'hypothetical_game_complete',detail:plan.stopReason};
    const jsonl=[JSON.stringify(header),...prefix,...records.map(JSON.stringify)].join('\n')+'\n';if(Buffer.byteLength(jsonl)>32*1024*1024)throw Error('生成回放超过 32 MB。');
    return{jsonl,trace,header,initialization:initialization(plan),state:s};
  }catch(error){error.step=activeStep;error.initialization=initialization(plan);error.trace=trace;throw error;}
}
module.exports={isLabReplay,labAnchors,sourceAt,compile,initialization,digest};
