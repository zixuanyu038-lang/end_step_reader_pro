'use strict';
const zlib=require('node:zlib'),crypto=require('node:crypto'),R=require('./replay');
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function difference(before,after){
  if(equal(before,after))return null;
  if(Array.isArray(after)){
    const keyed=after.every(x=>x&&typeof x==='object'&&Object.hasOwn(x,'id'))&&new Set(after.map(x=>String(x.id))).size===after.length;
    if(keyed&&Array.isArray(before)){
      const previous=new Map(before.filter(x=>x&&typeof x==='object').map(x=>[String(x.id),x]));
      return{a:after.map(value=>{const old=previous.get(String(value.id));if(!old)return{v:value};const p=difference(old,value);return p?{id:value.id,p}:{id:value.id};})};
    }
    return{s:after};
  }
  if(after&&typeof after==='object'&&before&&typeof before==='object'&&!Array.isArray(before)){
    const o={},d=Object.keys(before).filter(k=>!Object.hasOwn(after,k));
    for(const [key,value] of Object.entries(after)){const p=difference(before[key],value);if(p)o[key]=p;}
    return{o,...(d.length?{d}:{})};
  }
  return{s:after};
}
function visibleState(state,viewer,baseline=null){
  const result=baseline?{...clone(baseline),...clone(state)}:clone(state);
  const wirePhase=phase=>({COMBAT_BEGIN:'BEGIN_COMBAT',COMBAT_DECLARE_ATTACKERS:'DECLARE_ATTACKERS',COMBAT_DECLARE_BLOCKERS:'DECLARE_BLOCKERS',COMBAT_FIRST_STRIKE_DAMAGE:'FIRST_STRIKE_DAMAGE',COMBAT_END:'END_COMBAT',END_OF_TURN:'END_STEP'})[phase]||phase;
  result.phase=wirePhase(result.phase);result.step=wirePhase(result.step);
  result.pendingAction=state.status!=='COMPLETE'&&state.pendingAction?.type==='PRIORITY'?state.pendingAction:null;result.sideboarding=null;
  for(const [index,current] of result.players.entries()){
    const p=baseline?{...clone(baseline.players.find(p=>String(p.id)===String(current.id))||{}),...current}:current;result.players[index]=p;
    if(String(p.id)!==String(viewer))p.hand=p.hand.map(c=>({...c,name:'Hidden card',faceDown:true,types:[],subtypes:[],supertypes:[],keywords:[],oracleText:'',manaCost:'',cmc:0,power:0,toughness:0}));
  }
  delete result.clock;return result;
}
function paymentText(action){
  const sources=new Map();for(const mana of action.manaPaid||[]){const key=mana.sourceName;const list=sources.get(key)||[];list.push('{'+mana.color+'}');sources.set(key,list);}
  const mana=[...sources].map(([name,colors])=>name+' '+colors.join('')).join('；');
  const seen=new Set(),other=(action.paidCards||[]).filter(p=>/exil|discard|sacrific/i.test(p.kind)).flatMap(p=>p.cards.map(c=>({verb:/exil/i.test(p.kind)?'放逐':/discard/i.test(p.kind)?'弃掉':'牺牲',card:c}))).filter(p=>{const key=p.verb+':'+p.card.id;if(seen.has(key))return false;seen.add(key);return true;}).map(p=>p.verb+' '+p.card.name).join('；');
  return(mana||((action.tappedSources||[]).length?action.tappedSources.map(c=>c.name+' 横置').join('；'):'无需支付法术力'))+(action.lifeCost?'；支付 '+action.lifeCost+' 点生命':'')+(other?'；'+other:'')+((action.paidCards||[]).some(p=>!/exil|discard|sacrific/i.test(p.kind))?'；其他费用由 Forge 执行，见异能说明':'')+(action.lifeAfterPayment<action.lifeBefore-action.lifeCost?'；另有 '+(action.lifeBefore-action.lifeAfterPayment-action.lifeCost)+' 点生命损失':'');
}
function routeFromTrace(result){
  const route=[];if(result.path?.[0]?.kind==='pass')route.push({actorId:String(result.path[0].actorId),action:'pass',cardName:'',description:'在原节点让过优先权；对手仍有响应机会，由引擎继续处理。',payment:'无需支付。'});
  for(const frame of result.trace||[]){const a=frame.action;if(!a)continue;
    route.push({actorId:String(a.actorId),action:a.kind,cardName:a.cardName,description:'T'+frame.state.turnNumber+' · '+R.phase(frame.state.phase)+'：'+(a.description||a.cardName)+(a.modes?.length?'；模式：'+a.modes.join(' / '):''),payment:paymentText(a)});
    if(route.length>=9)break;
  }
  return route;
}
function compileReplay(source,run,{title='推荐分支',summary='',world,evidence=null,intent=null,quality=null}={}){
  if(!world||!Array.isArray(run.trace)||!run.trace.length)throw Error('缺少真实引擎轨迹或已固定隐藏世界。');
  const complete=run.stopReason==='game_over'&&run.state.status==='COMPLETE';
  if(!complete&&run.state.status==='COMPLETE')throw Error('引擎终局标记不一致。');
  const header={...source.header,games:source.game,complete,result:complete&&run.state.winnerId!=null?(String(run.state.winnerId)===String(source.header.seat)?'win':'loss'):null,
    branchMeta:{format:'endstep-forge-search-branch',version:1,title,summary,engine:'forge-2.0.15',validation:'forge-executed-with-audited-root',sourceSha256:source.sha256,anchorLine:source.anchor.line,selectedLine:source.anchor.selectedLine,
      hypothetical:true,scope:'single-game-continuation',complete,stop:{reason:run.stopReason,turn:run.state.turnNumber},worldId:world.id,seed:world.root.seed,scenario:world.scenario,
      deckInformationScope:'entire-replay-visible-information; retrospective inferred deck',assumptions:world.assumptions,intent,quality,
      search:evidence?{algorithm:evidence.algorithm,settings:evidence.settings,simulated:evidence.simulated,comparison:evidence.comparison,limitations:evidence.limitations}:null}};
  const prefix=source.rows.slice(1).filter(x=>x.line<source.anchor.line).map(x=>x.raw),out=[JSON.stringify(header),...prefix];
  const used=new Set(source.rows.filter(x=>x.row.k==='event').map(x=>String(x.row.event.sequenceNumber)));
  let time=source.anchor.t,seq=-7_000_000_000_000_000,previous=null,frames=0;
  function event(type,message,extra={}){while(used.has(String(seq)))seq++;const n=seq++;used.add(String(n));out.push(JSON.stringify({t:time,k:'event',event:{type,message,gameId:source.baseline.gameId,sequenceNumber:n,...extra}}));}
  function emit(state){const patch=previous?difference(previous,state):null;if(!previous||frames%30===0)out.push(JSON.stringify({t:time,k:'key',state}));else if(patch)out.push(JSON.stringify({t:time,k:'diff',patch}));previous=state;frames++;}
  for(const [index,frame] of run.trace.entries()){
    const state=visibleState(frame.state,source.header.seat,source.baseline);state.matchScore=clone(source.baseline.matchScore||{});state.priorityPromptVersion=Number(source.baseline.priorityPromptVersion||0)+index+1;
    if(state.status==='COMPLETE'){
      const score=state.matchScore,wins=[...(score.winsBySeat||[score.player0Wins||0,score.player1Wins||0])];
      if(state.winnerId!=null)wins[Number(state.winnerId)]++;
      Object.assign(score,{winsBySeat:wins,player0Wins:wins[0],player1Wins:wins[1],gamesPlayed:(score.gamesPlayed||source.game-1)+1,isMatchOver:wins.some(n=>n>=Math.ceil((score.gamesPerMatch||3)/2))});
    }
    if(index===0){emit(state);event('ADD_LOG',`[Forge 推荐分支 · ${complete?'完整后续':'搜索片段'} · 含隐藏信息假设] ${title}\n${summary}\n牌表依据整盘公开信息还原；手牌和牌库顺序来自固定假设世界，不是原局真实后续。`);
      if(quality)event('ADD_LOG','[AI 胜局二筛] '+quality.reason+'\n限制：'+quality.risks.join('；'));
      for(const a of world.assumptions)event('ADD_LOG',`[牌表来源 · 玩家 ${a.playerId}] ${a.archetype}\n${a.sourceUrl}\n${a.basis}`);
      event('ADD_LOG','[假设手牌] '+world.hiddenHands.map(h=>source.baseline.players.find(p=>String(p.id)===h.playerId)?.name+'：'+h.cards.join(' / ')).join('\n'));continue;
    }
    time+=frame.action?1500:500;
    if(previous&&state.turnNumber!==previous.turnNumber)event('TURN_BEGAN',`Turn ${state.turnNumber} (${state.players.find(p=>p.id===state.activePlayerId)?.name})`,{turnNumber:state.turnNumber,playerIndex:state.activePlayerId,playerName:state.players.find(p=>p.id===state.activePlayerId)?.name});
    if(previous&&state.phase!==previous.phase)event('TURN_PHASE',state.phase,{phase:state.phase,playerIndex:state.activePlayerId,playerName:state.players.find(p=>p.id===state.activePlayerId)?.name});
    if(frame.action&&String(frame.action.actorId)===String(source.header.seat))out.push(JSON.stringify({t:time,k:'action',prompt:previous?.pendingAction?.promptVersion,action:{type:'PLAY_CARD',cardId:frame.action.cardId,promptVersion:previous?.pendingAction?.promptVersion}}));
    emit(state);
    if(frame.action){const a=frame.action,p=state.players.find(p=>String(p.id)===String(a.actorId)),type={cast:'SPELL_CAST',activate:'ABILITY_ACTIVATED',play_land:'LAND_PLAYED'}[a.kind]||'ADD_LOG';
      event(type,`${p?.name||a.actorId} ${a.kind==='cast'?'cast':a.kind==='activate'?'activated':'played'} ${a.cardName}`,{cardId:a.cardId,cardName:a.cardName,playerIndex:String(a.actorId),playerName:p?.name});
      event('ADD_LOG','[Forge 支付] '+paymentText(a));
    }
    for(const message of frame.logs||[])if(message)event('ADD_LOG',message);
  }
  if(complete){const winner=run.state.winnerId;event('GAME_OUTCOME',winner==null?'Forge 判定本局平局':'Forge hypothetical winner: '+source.baseline.players.find(p=>String(p.id)===String(winner))?.name,{playerIndex:winner==null?undefined:String(winner),turnNumber:run.state.turnNumber,endReason:'forge-engine-outcome'});}
  event('ADD_LOG',complete?'[分支结束] Forge 已判定本局结束。此结果仅属于上述假设世界。':'[搜索片段结束] 达到搜索预算或深度边界，未宣称本局已经结束。');
  const jsonl=out.join('\n')+'\n';if(Buffer.byteLength(jsonl)>32*1024*1024)throw Error('生成回放超过 Endstep 已验证的 32 MB 解压上限。');
  const bytes=zlib.gzipSync(Buffer.from(jsonl));if(bytes.length>16*1024*1024)throw Error('生成回放超过 16 MB 压缩上限。');
  const parsed=R.parse(zlib.gunzipSync(bytes).toString('utf8'));
  if(parsed.warnings.some(w=>w.includes('状态恢复失败')))throw Error('导出回放未通过状态补丁往返核对。');
  return{bytes,jsonl,header,complete,frames,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
module.exports={difference,visibleState,paymentText,routeFromTrace,compileReplay};
