'use strict';
const crypto=require('node:crypto');
const {canonicalName}=require('./deck-service');
const {exactPhase}=require('./search-source');
const clone=x=>JSON.parse(JSON.stringify(x));
const ZONES=['hand','battlefield','graveyard','exile','commandZone'];
const manaColor=color=>({white:'W',blue:'U',black:'B',red:'R',green:'G',colorless:'C'})[color]||color;
const nameOf=(source,c)=>canonicalName(source.faces?.[String(c.id)]||c.name.split(' // ')[0]);
const countCards=list=>{const m=new Map();for(const c of list)m.set(c.name,(m.get(c.name)||0)+c.count);return m;};
const expand=m=>[...m].flatMap(([name,n])=>Array(n).fill(name));
const counts=m=>[...m].filter(([,n])=>n>0).map(([name,count])=>({name,count}));
function random(seed){let n=seed>>>0;return()=>{n+=0x6D2B79F5;let t=n;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function shuffle(list,rng){for(let i=list.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[list[i],list[j]]=[list[j],list[i]];}return list;}
function reject(message){throw Object.assign(Error(message),{code:'unsupported_root'});}
function applyCustomPressure(requested,slots,hand,library,locked){
  if(requested.length>slots.length)throw Error(`对手只有 ${slots.length} 个未知手牌位，你指定了 ${requested.length} 张牌。`);
  const key=name=>canonicalName(name.split(' // ')[0]).toLowerCase();
  const pending=[],free=slots.slice(),applied=Array(requested.length);
  for(const [index,name] of requested.entries()){
    const slot=free.findIndex(i=>key(hand[i].name)===key(name));
    if(slot<0)pending.push({index,name});
    else applied[index]=hand[free.splice(slot,1)[0]].name;
  }
  for(const {index,name} of pending){
    const card=library.find(c=>!locked.has(String(c.id))&&key(c.name)===key(name));
    if(!card)throw Error(`对手可分配的主牌中没有足够的 ${name}。请核对当前局的牌表和已知区域。`);
    const slot=free.shift();
    applied[index]=card.name;
    [hand[slot].name,card.name]=[card.name,hand[slot].name];
  }
  return applied;
}
function supportedStackTrigger(entry){
  return entry.isTrigger===true&&entry.sourceCard?.name==='Acererak the Archlich'&&entry.sourceCardZone==='Battlefield'
    &&entry.abilityDescription?.startsWith('When Acererak the Archlich enters,')&&!entry.optionalTrigger&&!entry.targets?.length;
}
function cardText(source,c,combat=false){
  if(c.faceDown||c.isCopyOfRealCard&&!c.isToken||c.isPhasedOut||!combat&&(c.isAttacking||c.isBlocking)||c.attachedCards?.length)reject('当前节点包含尚未恢复的牌面状态：'+c.name+'。');
  const name=nameOf(source,c);if(/[;|\r\n]/.test(name))reject('牌名包含不支持的局面分隔符。');
  let head=name;
  if(c.isToken){
    const keys=(c.keywords||[]).map(s=>s.toLowerCase());
    const script=/^Clue(?: Token)?$/.test(c.name)?'c_a_clue_draw':/^Spirit(?: Token)?$/.test(c.name)&&keys.includes('flying')?'w_1_1_spirit_flying':/^Angel(?: Token)?$/.test(c.name)&&keys.includes('flying')?'w_4_4_angel_flying':c.types?.includes('Creature')&&c.subtypes?.includes('Human')&&c.subtypes?.includes('Knight')&&keys.includes('trample')&&keys.includes('haste')?'r_2_2_human_knight_trample_haste':null;
    if(script)head='T:'+script;else if(c.name!=='Thundertrap Trainer')reject('尚未支持这个起点衍生物的规则恢复：'+c.name);
  }
  const out=[head,`Id:${c.id}`];
  if(c.tapped)out.push('Tapped');if(c.hasSummoningSickness)out.push('SummonSick');if(c.damage)out.push('Damage:'+c.damage);
  if(c.isTransformed||c.isBackFace){if(!source.faces?.[String(c.id)])reject('缺少双面牌的正面资料：'+c.name);out.push('Transformed');}
  const types={'+1/+1':'P1P1','-1/-1':'M1M1'};
  if(Object.keys(c.counters||{}).length)out.push('Counters:'+Object.entries(c.counters).map(([k,v])=>(types[k]||k.toUpperCase())+'='+v).join(','));
  for(const mark of c.chosenMarks||[]){
    if(/[;|\r\n]/.test(String(mark.value)))reject('选择的值包含不支持的分隔符。');
    if(mark.kind==='NAME')out.push('NamedCard:'+mark.value);
    else if(mark.kind==='NUMBER')out.push('ChosenNumber:'+mark.value);
    else if(mark.kind==='COLOR')out.push('ChosenColor:'+mark.value);
    else if(mark.kind==='TYPE')out.push('ChosenType:'+mark.value);
    else reject('尚未支持这个已选值：'+mark.kind);
  }
  if(String(c.ownerId)!==String(c.controllerId))out.push('Owner:p'+c.ownerId);
  return out.join('|');
}
function combatAt(source,phase){
  if(!['BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS','FIRST_STRIKE_DAMAGE','COMBAT_DAMAGE','END_COMBAT'].includes(phase))return null;
  const state=source.baseline,board=state.players.flatMap(p=>p.battlefield),attacking=board.filter(c=>c.isAttacking);
  const turnStart=source.history?.findLast(x=>x.event.type==='TURN_BEGAN'&&Number(x.event.turnNumber)===Number(state.turnNumber))?.sourceLine||0;
  const begin=source.history?.findLast(x=>x.sourceLine>turnStart&&x.event.type==='TURN_PHASE'&&['COMBAT_BEGIN','BEGIN_COMBAT'].includes(x.event.phase))?.sourceLine||turnStart;
  const block=source.history?.findLast(x=>x.sourceLine>begin&&x.event.type==='BLOCKERS_DECLARED')?.event;
  const afterBlocks=['DECLARE_BLOCKERS','FIRST_STRIKE_DAMAGE','COMBAT_DAMAGE','END_COMBAT'].includes(phase);
  if(board.some(c=>c.isBlocking)||Number(block?.amount)>0)
    reject('此优先权窗口已记录，录像缺少可核对的阻挡关系。');
  if(attacking.length&&afterBlocks&&Number(block?.amount)!==0)
    reject('此优先权窗口已记录，无法核对宣告阻挡后的战斗状态。');
  if(attacking.length&&phase==='FIRST_STRIKE_DAMAGE')
    reject('此优先权窗口已记录，尚无法核对先攻伤害分配。');
  const attackers=attacking.map(card=>{
    const defender=Number(card.attackingDefenderId);
    if(!Number.isInteger(defender)||defender<-2||!defender||
      defender>0&&!board.some(c=>Number(c.id)===defender))reject('无法核对攻击的目标：'+card.name+'。');
    return {card:card.id,defender,blocked:afterBlocks?false:null};
  });
  return {attackers};
}
function buildWorld(source,decks,catalog,seed,{stressCard=null,stressCards=[]}={}){
  const state=source.baseline;
  if(state.players.length!==2)reject('目前只支持双人对局。');
  const phase=exactPhase(state),combat=combatAt(source,phase);
  if(phase==='CLEANUP')reject('此优先权窗口已记录，尚无法核对清除步骤的额外优先权。');
  if(state.stack?.some(s=>(s.isAbility||s.isTrigger)&&!supportedStackTrigger(s)))reject('该节点包含尚未支持恢复的堆叠异能。');
  if(state.stack?.some(supportedStackTrigger)){
    const start=source.rows?.findLast(r=>r.line<source.anchor.line&&r.row.k==='chapter'&&r.row.edge==='start')?.line||0;
    const ventured=source.rows?.some(r=>r.line>=start&&r.line<source.anchor.line&&r.row.k==='event'&&(/DUNGEON|VENTURE/.test(r.row.event.type)||/\b(?:ventures into|ventured into|completes? (?:the )?dungeon)\b/i.test(r.row.event.message||'')));
    if(ventured||state.players.some(p=>p.commandZone?.some(c=>c.types?.includes('Dungeon'))))reject('这个起点已有地下城进度，尚无法核对恢复。');
  }
  if(state.players.some(p=>p.hasInitiative))reject('起点已有主动权，但尚未恢复完整地下城进度。');
  if(state.isDay||state.isNight)reject('这个起点包含尚未核对恢复的昼夜状态。');
  if(source.activeUnrestoredEffects?.length)reject('该节点仍有需要恢复的持续效果：'+source.activeUnrestoredEffects.map(e=>e.cardName).join('；'));
  if(source.historyUncertainties?.length)reject(source.historyUncertainties.join('；'));
  const stressRequested=stressCard;let stressApplied=false,customApplied=[];
  const rng=random(seed),assumptions=[],hands=[],libraries=[],adaptedDecks=[],lines=[];
  const aliases={END_STEP:'END_OF_TURN',BEGIN_COMBAT:'COMBAT_BEGIN',DECLARE_ATTACKERS:'COMBAT_DECLARE_ATTACKERS',
    DECLARE_BLOCKERS:'COMBAT_DECLARE_BLOCKERS',FIRST_STRIKE_DAMAGE:'COMBAT_FIRST_STRIKE_DAMAGE',END_COMBAT:'COMBAT_END'};
  lines.push('turn='+state.turnNumber,'activeplayer=p'+state.activePlayerId,'activephase='+(aliases[phase]||phase));
  let nextId=1_500_000_000;
  const allCurrent=new Set(state.players.flatMap(p=>ZONES.flatMap(z=>p[z]||[])).concat((state.stack||[]).map(s=>s.sourceCard)).map(c=>String(c.id)));
  for(const [index,player] of state.players.entries()){
    const supplied=decks[index];if(!supplied?.verified)reject('隐藏世界必须使用核对过来源的牌表。');
    const pool=countCards(supplied.main.map(c=>({...c,name:canonicalName(c.name.split(' // ')[0])}))),side=countCards(supplied.sideboard.map(c=>({...c,name:canonicalName(c.name.split(' // ')[0])})));
    const companions=(player.commandZone||[]).filter(c=>c.isCompanion);
    if(companions.length>1)reject('起点有多张已宣告行侣，无法核对。');
    const companion=companions[0];
    if(companion){
      const name=nameOf(source,companion);
      const effect=(player.commandZone||[]).filter(c=>c.name===companion.name+"'s Companion Effect");
      if(String(companion.ownerId)!==String(player.id)||companion.faceDown||effect.length!==1||!(side.get(name)>0))
        reject('无法核对已宣告行侣与备牌：'+name);
      side.set(name,side.get(name)-1);
    }
    const physical=c=>!c.isCompanion&&c.name!=='Hidden card'&&!c.faceDown&&!c.isToken&&!(c.zone==='Command'&&!c.isCommander);
    const known=ZONES.flatMap(z=>(player[z]||[]).filter(physical)).concat((state.stack||[]).filter(s=>!s.isAbility&&!s.isTrigger&&String(s.sourceCard.ownerId)===String(player.id)).map(s=>s.sourceCard));
    const libraryKnown=source.descriptionSetup||String(player.id)===String(source.header.seat)?source.known.filter(c=>String(c.ownerId)===String(player.id)&&!allCurrent.has(String(c.id))&&!c.isToken&&!c.isCompanion&&c.name!=='Hidden card'):[];
    const required=new Map();for(const c of known.concat(libraryKnown)){const name=nameOf(source,c);required.set(name,(required.get(name)||0)+1);}
    const replacements=[];
    function removeSpare(preferLand){
      const candidates=[...pool].filter(([name,n])=>n>(required.get(name)||0));
      if(!candidates.length)reject('相近牌表无法容纳已知牌，需要更匹配的来源。');
      candidates.sort((a,b)=>Number(!!catalog.get(b[0])?.land===preferLand)-Number(!!catalog.get(a[0])?.land===preferLand)||b[1]-a[1]||a[0].localeCompare(b[0]));
      const name=candidates[0][0];pool.set(name,pool.get(name)-1);return name;
    }
    for(const [name,min] of required){
      if(!catalog.get(name)?.found)reject('Forge 数据库没有这张牌：'+name);
      while((pool.get(name)||0)<min){if(supplied.fixedForGame)reject('固定牌表与节点已知牌冲突：'+name);const removed=removeSpare(!!catalog.get(name)?.land);pool.set(name,(pool.get(name)||0)+1);replacements.push({removed,added:name,basis:'preserve a card already observed before this node'});}
    }
    const targetSize=source.initialDeckSizes?.[String(player.id)]||supplied.main.reduce((n,c)=>n+c.count,0);
    if(supplied.fixedForGame&&expand(pool).length!==targetSize)reject('固定牌表张数与节点记录不一致。');
    while(expand(pool).length>targetSize){const removed=removeSpare(false);replacements.push({removed,added:null,basis:'match recorded starting deck size'});}
    while(expand(pool).length<targetSize){
      const choices=supplied.main.filter(c=>!required.has(c.name));if(!choices.length)reject('无法匹配实际起始牌库张数。');
      const added=choices[Math.floor(rng()*choices.length)].name;pool.set(added,(pool.get(added)||0)+1);replacements.push({removed:null,added,basis:'match recorded starting deck size; hypothetical extra slot'});
    }
    if(replacements.length>Math.ceil(targetSize*.2))reject('公开牌与找到的牌表差异过大，需要另找更接近的牌表。');
    adaptedDecks.push({main:counts(pool),sideboard:counts(side)});
    const totalCurrent=known.length+player.hand.filter(c=>c.name==='Hidden card'||c.faceDown).length+player.librarySize;
    if(totalCurrent!==targetSize)reject('该节点的主牌数量与起始牌表不符，可能有备牌调取或不可见区域变化，暂不猜测区域来源。');
    function take(name){const n=pool.get(name)||0;if(!n)reject('牌表缺少已知牌：'+name);pool.set(name,n-1);}
    for(const c of known)take(nameOf(source,c));
    const reserved=libraryKnown.map(c=>({id:c.id,name:nameOf(source,c)}));for(const c of reserved)take(c.name);
    let remaining=shuffle(expand(pool),rng);
    const hand=player.hand.map(c=>{
      if(c.name!=='Hidden card'&&!c.faceDown)return clone(c);
      let name;
      if(stressCard&&String(player.id)!==String(source.header.seat)&&remaining.includes(stressCard)){
        name=stressCard;remaining.splice(remaining.indexOf(name),1);stressCard=null;stressApplied=true;
      }else name=remaining.pop();
      if(!name)reject('没有足够牌填充隐藏手牌。');
      return{id:c.id,name,ownerId:player.id,controllerId:player.id,zone:'Hand',faceDown:false,tapped:false,counters:{}};
    });
    let library=shuffle(reserved.concat(remaining.map(name=>({id:nextId++,name}))),rng);
    const top=source.knownTop?.[String(player.id)]||[];
    for(let n=top.length-1;n>=0;n--){const i=library.findIndex(c=>String(c.id)===String(top[n]));if(i<0)reject('已知牌库顶不在假设牌库中。');library.unshift(library.splice(i,1)[0]);}
    if(stressCards.length&&String(player.id)!==String(source.header.seat)){
      const slots=player.hand.flatMap((c,i)=>c.name==='Hidden card'||c.faceDown?[i]:[]);
      const locked=new Set(top.concat(reserved.map(c=>c.id)).map(String));
      customApplied=applyCustomPressure(stressCards,slots,hand,library,locked);
    }
    if(library.length!==player.librarySize)reject('假设牌库长度与原节点不一致。');
    hands.push({playerId:String(player.id),cards:hand.map(c=>c.name),hiddenCount:player.hand.filter(c=>c.name==='Hidden card'||c.faceDown).length});
    libraries.push({playerId:String(player.id),cards:library,knownTop:top});
    assumptions.push({id:'deck-'+player.id,playerId:String(player.id),basis:supplied.basis,archetype:supplied.archetype,sourceUrl:supplied.url,sourceSha256:supplied.sha256,hypothesisId:supplied.hypothesisId||null,deckInformationScope:supplied.deckInformationScope||'node prefix',mainDeck:supplied.main,sideboard:supplied.sideboard,sideboardPlan:supplied.sideboardPlan||null,replacements:(supplied.adjustments||[]).concat(replacements),hand:hand.map(c=>c.name),seed,confidence:'low'});
    const prefix='p'+player.id,h=source.historyCounters[index];lines.push(prefix+'life='+player.life,prefix+'landsplayed='+h.landsPlayedThisTurn);
    const counters=[['poisonCounters','POISON'],['energyCounters','ENERGY'],['experienceCounters','EXPERIENCE'],['radCounters','RAD']].filter(([key])=>player[key]>0).map(([key,name])=>name+'='+player[key]);if(counters.length)lines.push(prefix+'counters='+counters.join(','));
    if(player.ringTempts)lines.push(prefix+'numringtemptedyou='+player.ringTempts);
    const mana=Object.entries(player.manaPool||{}).flatMap(([color,n])=>Array(n).fill(manaColor(color))).join(' ');if(mana)lines.push(prefix+'manapool='+mana);
    for(const zone of ZONES){const list=zone==='hand'?hand:(player[zone]||[]).filter(c=>!(zone==='commandZone'&&!c.isCommander&&!c.isCompanion));lines.push(prefix+(zone==='commandZone'?'command':zone)+'='+list.map(c=>cardText(source,c,zone==='battlefield'&&!!combat)).join(';'));}
    lines.push(prefix+'library='+library.map(c=>cardText(source,{...c,ownerId:player.id,controllerId:player.id})).join(';'));
    let sideId=1_800_000_000+index*1000;lines.push(prefix+'sideboard='+expand(side).map(name=>cardText(source,{id:sideId++,name,ownerId:player.id,controllerId:player.id})).join(';'));
  }
  const root={stateText:lines.join('\n')+'\n',seed,viewerId:Number(source.header.seat),names:state.players.map(p=>p.name),gameId:state.gameId,activePlayerId:Number(state.activePlayerId),priorityPlayerId:Number(state.priorityPlayerId),firstPriorityId:source.firstPriorityId,history:source.historyCounters,cardHistory:source.cardHistory,decks:adaptedDecks,stack:state.stack||[],spellHistory:source.spellHistory||[],tokens:state.players.flatMap(p=>ZONES.flatMap(z=>p[z]||[]).filter(c=>c.isToken&&c.name==='Thundertrap Trainer')),statuses:state.players.map(p=>({hasMonarch:!!p.hasMonarch,hasInitiative:!!p.hasInitiative,hasCitysBlessing:!!p.hasCitysBlessing,companion:(p.commandZone||[]).find(c=>c.isCompanion),
      commandEffects:(p.commandZone||[]).filter(c=>!c.isCommander&&!c.isCompanion)}))};
  if(combat)root.combat=combat;
  const impending=state.players.flatMap(p=>p.battlefield||[]).filter(c=>!c.types?.includes('Creature')&&
    Object.entries(c.counters||{}).some(([key,count])=>key.toUpperCase()==='TIME'&&count>0)&&
    c.keywords?.some(k=>/^Impending\b/i.test(k))).map(c=>Number(c.id));
  if(impending.length)root.impending=impending;
  const scenario=customApplied.length?{kind:'custom-interaction-stress',cards:customApplied,basis:'Player-specified cards in the opponent’s hidden hand, from the fixed deck.'}:stressApplied?{kind:'targeted-interaction-stress',card:stressRequested,basis:'explicitly assumes one plausible interaction card from the fixed deck; not a probability sample'}:{kind:'deck-sampled-hidden-hand'};
  const id=crypto.createHash('sha256').update(JSON.stringify({root,version:1,...(customApplied.length?{scenario}:{})})).digest('hex');
  return{id,root,assumptions,hiddenHands:hands,libraries,sourceUrls:decks.map(d=>d.url),scenario};
}
function auditObservedAction(source,actions){
  const observed=source.inferredAction;
  if(observed&&!actions.some(a=>a.kind===observed.kind&&String(a.cardId)===String(observed.cardId)))
    reject('Forge 无法从操作前快照重现这张牌的原操作。');
}
function auditRoot(source,actual){
  const failures=[];
  const same=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))failures.push(label);};
  same(actual.players.length,source.baseline.players.length,'玩家数量');
  same(Number(actual.turnNumber),Number(source.baseline.turnNumber),'回合数');same(String(actual.activePlayerId),String(source.baseline.activePlayerId),'主动玩家');same(String(actual.priorityPlayerId),String(source.baseline.priorityPlayerId),'优先权');
  const phase=x=>({END_STEP:'END_OF_TURN',BEGIN_COMBAT:'COMBAT_BEGIN',DECLARE_ATTACKERS:'COMBAT_DECLARE_ATTACKERS',
    DECLARE_BLOCKERS:'COMBAT_DECLARE_BLOCKERS',FIRST_STRIKE_DAMAGE:'COMBAT_FIRST_STRIKE_DAMAGE',END_COMBAT:'COMBAT_END'})[x]||x;
  same(phase(actual.phase),phase(exactPhase(source.baseline)),'阶段');
  const stackIdentity=s=>[s.sourceCard.name,String(s.sourceCard.id),!!s.isAbility,!!s.isTrigger,String(s.controllerId??s.sourceCard.controllerId)];
  same(actual.stack.map(stackIdentity),source.baseline.stack.map(stackIdentity),'堆叠顺序、来源牌与控制者');
  for(const [i,p] of source.baseline.players.entries()){
    const q=actual.players[i];if(!q)continue;same(q.life,p.life,'生命 '+p.id);same(q.librarySize,p.librarySize,'牌库张数 '+p.id);same(q.handSize,p.handSize,'手牌张数 '+p.id);
    const normPool=x=>Object.fromEntries(Object.entries(x||{}).filter(([,n])=>n>0).map(([color,n])=>[manaColor(color),n]).sort(([a],[b])=>a.localeCompare(b)));same(normPool(q.manaPool),normPool(p.manaPool),'法术力池 '+p.id);
    same(q.drawnThisTurn,source.historyCounters[i].numDrawnThisTurn,'抓牌历史 '+p.id);same(q.landsPlayedThisTurn,source.historyCounters[i].landsPlayedThisTurn,'下地历史 '+p.id);
    same(q.spellsCastThisTurn,source.historyCounters[i].spellsCastThisTurn,'施法历史 '+p.id);
    for(const zone of ZONES){const original=p[zone]||[],restored=q[zone]||[];same(restored.length,original.length,zone+' 数量 '+p.id);
      for(const c of original){if(c.name==='Hidden card'||c.faceDown)continue;const d=restored.find(x=>String(x.id)===String(c.id));if(!d){failures.push('缺少 '+c.name);continue;}
        same(d.name,c.name,'牌面 '+c.name);
        if(c.isCompanion)same(!!d.isCompanion,true,'已宣告行侣 '+c.name);
        if(zone==='battlefield'){
          same(d.types?.includes('Creature')||false,c.types?.includes('Creature')||false,'生物类别 '+c.name);
          same(!!d.isAttacking,!!c.isAttacking,'攻击状态 '+c.name);
          same(!!d.isBlocking,!!c.isBlocking,'阻挡状态 '+c.name);
          if(c.isAttacking)same(Number(d.attackingDefenderId),Number(c.attackingDefenderId),'攻击目标 '+c.name);
          same(d.tapped,!!c.tapped,'横置 '+c.name);same(d.hasSummoningSickness,!!c.hasSummoningSickness,'召唤失调 '+c.name);same(d.damage,c.damage||0,'伤害 '+c.name);
          const norm=x=>Object.fromEntries(Object.entries(x||{}).map(([k,v])=>[({'+1/+1':'P1P1','-1/-1':'M1M1'})[k]||k.toUpperCase(),v]).sort(([a],[b])=>a.localeCompare(b)));
          same(norm(d.counters),norm(c.counters),'指示物 '+c.name);
          if(c.types?.includes('Creature')){same(d.power,c.power,'力量 '+c.name);same(d.toughness,c.toughness,'防御力 '+c.name);}
          const keyword=x=>x.toLowerCase().replace(/^evoke(?:—exile a white card from your hand|:exilefromhand<1\/card\.white\+other\/white card>)$/,'evokeexilewhitecard').replace(/[^a-z0-9]/g,'');for(const k of c.keywords||[])if(!(d.keywords||[]).some(actual=>keyword(actual)===keyword(k)))failures.push('异能 '+c.name+' '+k);
          for(const mark of c.chosenMarks||[])if(mark.kind==='NAME')same(d.chosenMarks?.find(m=>m.kind==='NAME')?.value,mark.value,'命名 '+c.name);
        }
      }
    }
    same(!!q.hasMonarch,!!p.hasMonarch,'君主 '+p.id);same(!!q.hasInitiative,!!p.hasInitiative,'主动权 '+p.id);
  }
  if(failures.length)reject('Forge 局面恢复核对失败：'+failures.join('；'));return{passed:true,checks:'visible zones, life, card identities, tap, damage, counters, power/toughness, naming and restored turn history'};
}
module.exports={buildWorld,auditRoot,auditObservedAction,cardText,random,shuffle};
