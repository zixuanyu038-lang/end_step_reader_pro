'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {compact}=require('./tree-search');
const {compileReplay}=require('./forge-replay');
const {auditRoot,auditObservedAction}=require('./hidden-worlds');

async function inspectControlledRoot({source,world,worker,signal}){
  const initial=await worker.request({command:'expand',root:world.root,path:[],exhaustive:true},{signal});
  if(initial.stopReason!=='decision')throw Error('Forge 没有恢复到决策点。');
  auditRoot(source,initial.state);
  auditObservedAction(source,initial.actions);
  for(const [i,p] of source.baseline.players.entries())
    if((source.knownTop?.[String(p.id)]||[]).some((id,n)=>String(initial.rootLibraries[i][n]?.id)!==String(id)))
      throw Error('Forge 恢复的牌库顶和录像不一致。');
  return initial;
}

function withPublicHand(source){
  const baseline=structuredClone(source.baseline),seat=String(source.header.seat);
  const opponent=baseline.players.find(p=>String(p.id)!==seat),id=String(opponent.id);
  const publicHand=new Map();
  const start=source.rows.findLast(r=>r.line<source.anchor.line&&r.row.k==='chapter'&&r.row.edge==='start')?.line||0;
  for(const {line,row} of source.rows){
    if(line<start||line>=source.anchor.line||row.event?.type!=='CARD_ZONE_CHANGE')continue;
    const e=row.event,owner=e.zoneOwnerIndex??e.playerIndex;
    if(e.fromZone==='Hand'&&e.toZone!=='Hand'&&(owner==null||String(owner)===id)){
      if(e.cardId==null)publicHand.clear();
      else publicHand.delete(String(e.cardId));
    }
    if(e.toZone==='Hand'&&String(owner)===id&&e.cardId!=null&&e.cardName){
      const known=source.known.find(c=>String(c.id)===String(e.cardId));
      if(known&&known.name===e.cardName)publicHand.set(String(e.cardId),known);
    }
  }
  const hidden=opponent.hand.flatMap((card,index)=>card.faceDown||card.name==='Hidden card'?[index]:[]);
  const missing=[...publicHand.values()].filter(c=>!opponent.hand.some(h=>String(h.id)===String(c.id)));
  if(missing.length>hidden.length)return {source,publicNames:[]};
  for(const [i,c] of missing.entries())opponent.hand[hidden[i]]={...c,zone:'Hand',faceDown:false,tapped:false,counters:{}};
  return {source:{...source,baseline},publicNames:missing.map(c=>c.name)};
}

function describeTrace(run,source){
  const viewer=String(source.header.seat);
  const final=run.state.players.map(p=>({id:String(p.id),life:p.life,library:p.librarySize}));
  const actions=run.trace.filter(f=>f.action).map(f=>({turn:f.state.turnNumber,actor:String(f.action.actorId),
    card:f.action.cardName,description:f.action.description||f.label}));
  const end=run.trace.findIndex(f=>f.state.status==='COMPLETE');
  const endIndex=end<0?run.trace.length-1:end;
  const closing=[...new Set(run.trace.slice(Math.max(0,endIndex-5),endIndex+1).flatMap(f=>f.logs||[]))].slice(-10);
  const swing=[];
  for(let i=1;i<run.trace.length;i++){
    const before=run.trace[i-1].state,after=run.trace[i].state;
    for(const player of after.players){
      const previous=before.players.find(p=>String(p.id)===String(player.id));
      if(previous&&Number(player.life)<Number(previous.life))
        swing.push({turn:after.turnNumber,actor:String(player.id),from:previous.life,to:player.life,logs:(run.trace[i].logs||[]).slice(-3)});
    }
  }
  const highlights=[];
  const bounce=actions.find(a=>a.actor===viewer&&a.turn<=Number(source.baseline.turnNumber)+1&&
    /Return target .* to its owner's hand/i.test(a.description));
  const bounced=bounce&&/\(Targeting: (.+?) \(\d+\)/i.exec(bounce.description);
  if(bounced)highlights.push('T'+bounce.turn+' 我方用了 '+bounce.card+'，把 '+bounced[1]+' 送回手牌');
  const interaction=actions.find(a=>a.actor!==viewer&&a.turn<=Number(source.baseline.turnNumber)+2&&
    /\b(?:Exile|Counter|Destroy)\b/i.test(a.description));
  if(interaction){
    const target=/\b(Exile|Counter|Destroy) (.+?) \(\d+\)/i.exec(interaction.description);
    const verb=target&&{exile:'放逐',counter:'反击',destroy:'消灭'}[target[1].toLowerCase()];
    highlights.push('T'+interaction.turn+' 对手用了 '+interaction.card+(verb?'，'+verb+'了 '+target[2]:''));
  }
  const lethal=swing.findLast(x=>Number(x.from)>0&&Number(x.to)<=0);
  if(lethal){
    const damage=lethal.logs.map(log=>/^(.+?) \(\d+\) deals (\d+) (combat|non-combat) damage/.exec(log)).find(Boolean);
    const side=lethal.actor===viewer?'我方':'对手';
    const life=side+'生命从 '+lethal.from+' 降到 '+lethal.to;
    const hit=damage&&damage[1]+' 造成 '+damage[2]+' 点'+(damage[3]==='combat'?'战斗':'非战斗')+'伤害';
    highlights.push('T'+lethal.turn+' '+(hit&&Number(damage[2])===lethal.from-lethal.to?hit+'，'+life:
      hit?life+'，其中 '+hit:life));
  }else{
    const rule=closing.find(log=>/has lost because/i.test(log));
    if(rule)highlights.push(rule);
  }
  return {winner:run.state.winnerId??null,viewer,final,highlights,opening:actions.slice(0,7),closing,lifeChanges:swing.slice(-5)};
}

async function controlledComparison({source,world,plan,worker,signal}){
  const {name,baselineKey,alternateKey}=plan;
  assert.ok(typeof name==='string'&&name.length>0&&name.length<=80&&path.basename(name)===name&&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name),'Invalid comparison name.');
  assert.ok(baselineKey!==alternateKey,'Choose two different legal actions.');
  const initial=await inspectControlledRoot({source,world,worker,signal});
  const prefix=(plan.prefix||[]).map(compact);
  const request=(command,actions,includeTrace=false)=>worker.request({
    command,root:world.root,path:actions,includeTrace,enumerateChoices:true,
    exhaustive:true,skipForcedPasses:true,horizonTurns:100
  },{signal});
  const fork=prefix.length?await request('expand',prefix):initial;
  const actions=[baselineKey,alternateKey].map(key=>fork.actions.find(action=>action.key===key));
  assert.ok(fork.stopReason==='decision'&&actions.every(Boolean)&&
    actions.every(action=>String(action.actorId)===String(source.header.seat)),
    'Both moves must be legal at the same decision for the replay player.');
  const arms=[];
  const targetName=reference=>{
    const [kind,id]=reference.split(':');
    if(kind==='p')return id===String(source.header.seat)?'我方':'对手';
    if(kind==='s')return fork.state.stack.find(item=>String(item.sourceCard?.id)===id)?.sourceCard?.name||reference;
    return fork.state.players.flatMap(player=>['hand','battlefield','graveyard','exile','commandZone'].flatMap(zone=>player[zone]||[]))
      .find(card=>String(card.id)===id)?.name||reference;
  };
  for(const [i,action] of actions.entries()){
    const route=prefix.concat(compact(action));
    const run=await request('simulate',route,true);
    assert.deepEqual(run.decisions.slice(0,route.length).map(a=>a.key),route.map(a=>a.key),'Engine did not replay the requested path.');
    const role=i?'改法':'对照';
    const replay=compileReplay(source,run,{title:name+' · '+role,world,
      summary:'同一回放起点、暗手、牌库和共同前缀。只替换这个决策，其余由相同 Forge 策略续打。\n'+action.label});
    assert.ok(replay.complete,'Comparison did not reach a game result.');
    const printed=action.label.split(/\r?\n\s*\r?\n/).at(-1).trim();
    const modes=action.modeDescriptions?.length?action.modeDescriptions:action.modes?.length&&printed!==action.label.trim()?[printed]:[];
    arms.push({role,action:{...compact(action),modes,
      targets:(action.targets||[]).flat().map(targetName)},result:replay.header.result,turn:run.state.turnNumber,
      file:name+'-'+role+'.esreplay',sha256:createHash('sha256').update(replay.bytes).digest('hex'),
      reason:describeTrace(run,source),bytes:replay.bytes});
  }
  return {line:plan.line,world:world.id,seed:world.root.seed,name,prefix,fork:{turn:fork.state.turnNumber,phase:fork.state.phase},arms};
}

module.exports={controlledComparison,withPublicHand,inspectControlledRoot};
