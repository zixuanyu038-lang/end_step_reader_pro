'use strict';
const crypto=require('node:crypto');
const R=require('./replay');
const {canonicalName,DeckLookupError,readDeckPreferences}=require('./deck-service');
const Schema=require('./search-schema'),{validate}=require('./studio-schema');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const counts=names=>{const result=new Map();for(const name of names)result.set(name,(result.get(name)||0)+1);return[...result].map(([name,count])=>({name,count}));};
const mapCounts=list=>new Map(list.map(c=>[canonicalName(c.name.split(' // ')[0]),c.count]));
const total=m=>[...m.values()].reduce((a,b)=>a+b,0);
function scanMatch(text){
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((raw,i)=>({raw,line:i+1})).filter(x=>x.raw.trim()).map(x=>({...x,row:JSON.parse(x.raw)}));
  const header=rows[0].row,viewer=String(header.seat),games=new Map(),recorded=new Map(),faces=new Map();let state=null,game=1;
  const current=()=>{if(!games.has(game))games.set(game,{game,players:new Map(),initialDeckSizes:{}});return games.get(game);};
  function remember(c,owner){
    if(c.id==null||!c.name||c.name==='Hidden card'||c.faceDown||c.isToken||c.isCopyOfRealCard||c.zone==='Player'||c.types?.includes('Player')||c.zone==='Command'&&!c.isCommander&&!c.isCompanion)return;
    const id=String(owner??c.ownerId);if(!['0','1'].includes(id))return;
    const key=game+':'+id+':'+c.id;
    const front=c.isTransformed||c.isBackFace?c.alternateFaceName:c.name;
    if(front)faces.set(key,front.split(' // ')[0]);
    const name=canonicalName(faces.get(key)||c.name.split(' // ')[0]);
    const g=current();if(!g.players.has(id))g.players.set(id,new Map());g.players.get(id).set(String(c.id),{...c,name,ownerId:id});
  }
  for(const x of rows.slice(1)){
    const r=x.row;if(r.k==='chapter'&&r.edge==='start')game=r.game;
    if(r.k==='key')state=r.state;else if(r.k==='diff')state=R.patch(state,r.patch);
    if(!state)continue;
    if(!state.sideboarding){
      for(const p of state.players){
        const g=current();if(g.initialDeckSizes[p.id]==null)g.initialDeckSizes[p.id]=p.librarySize+(p.handSize||0)+['battlefield','graveyard','exile'].reduce((n,z)=>n+(p[z]||[]).filter(c=>!c.isToken).length,0)+(state.stack||[]).filter(s=>String(s.sourceCard?.ownerId)===String(p.id)&&!s.isAbility).length;
        if(g.startingPlayerId==null&&Number(state.turnNumber)===1)g.startingPlayerId=String(state.activePlayerId);
        for(const zone of ['battlefield','graveyard','exile'])for(const c of p[zone]||[])remember(c,p.id);
        for(const c of p.hand||[])if(String(p.id)===viewer||!c.faceDown)remember(c,p.id);
      }
      for(const stack of state.stack||[])if(stack.sourceCard)remember(stack.sourceCard);
      if(state.pendingAction?.contextType!=='sideboard')for(const c of state.pendingAction?.cardOptions||[]){
        const owner=String(c.ownerId??state.players.find(p=>p.name===c.ownerName)?.id??viewer);
        if(!c.stackKind&&!current().players.get(owner)?.has(String(c.id)))remember(c,owner);
      }
    }
    if(r.k==='action'&&r.action.type==='SIDEBOARD_SUBMIT'&&state.pendingAction?.contextType==='sideboard'){
      const options=state.pendingAction.cardOptions||[],mainCount=state.pendingAction.sideboardState?.mainCount;
      if(!Number.isInteger(mainCount)||mainCount<40||!options.every((c,i)=>c.id===i))continue;
      const selected=r.action.orderedCards;if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(i=>!options[i]))continue;
      const proof=hash({options,selected,line:x.line});
      const make=(main,side,basis,kind)=>({found:true,verified:true,sourceKind:kind,archetype:'录制侧牌表',url:'replay:line:'+x.line,date:header.recordedAt||'',basis,sha256:proof,main:counts(main.map(c=>c.name)),sideboard:counts(side.map(c=>c.name)),recordedLine:x.line});
      const prefix=options.slice(0,mainCount),rest=options.slice(mainCount);
      const known=[...(current().players.get(viewer)?.values()||[])];
      const offsets=new Map();for(const c of known)for(const o of options)if(o.name===c.name){const offset=Number(c.id)-o.id;offsets.set(offset,(offsets.get(offset)||0)+1);}
      const offset=[...offsets].sort((a,b)=>b[1]-a[1])[0]?.[0];
      const orderingMatches=offset!=null&&known.length>=5&&known.every(c=>options[Number(c.id)-offset]?.name===c.name&&Number(c.id)-offset<mainCount);
      if(orderingMatches)recorded.set(game+':'+viewer,make(prefix,rest,'依据录制的换备选项前 mainCount 张恢复主牌；已用本局全部可见实体牌的 ID 顺序核对这一划分。','recorded-main-order'));
      const selection=new Set(selected);recorded.set((game+1)+':'+viewer,make(selected.map(i=>options[i]),options.filter(c=>!selection.has(c.id)),'直接依据录制的 SIDEBOARD_SUBMIT 选择恢复换备后的主牌与备牌。','recorded-sideboard-submission'));
    }
  }
  const global=[];
  for(const playerId of ['0','1']){
    const maximum=new Map();for(const g of games.values())for(const c of counts([...(g.players.get(playerId)?.values()||[])].map(c=>c.name)))maximum.set(c.name,Math.max(maximum.get(c.name)||0,c.count));
    global.push({playerId,cards:[...maximum].map(([name,count])=>({name,count}))});
  }
  return{header,games,recorded,global,scope:'entire-replay-visible-information; hindsight deck reconstruction; no future draw order'};
}
function fixDeck(base,observed,size,catalog,matchObserved=observed){
  const pool=mapCounts(base.main),side=mapCounts(base.sideboard),required=mapCounts(observed),adjustments=[...(base.adjustments||[])];
  const matchMinimum=mapCounts(matchObserved);
  function removeSpare(preferLand,moveToSideboard=false){
    const spare=[...pool].filter(([name,n])=>n>(required.get(name)||0)&&(moveToSideboard||n+(side.get(name)||0)>(matchMinimum.get(name)||0)));
    if(!spare.length)return null;
    spare.sort((a,b)=>Number(!!catalog.get(b[0])?.land===preferLand)-Number(!!catalog.get(a[0])?.land===preferLand)||b[1]-a[1]||a[0].localeCompare(b[0]));
    const name=spare[0][0];pool.set(name,pool.get(name)-1);return name;
  }
  for(const [name,n] of required)while((pool.get(name)||0)<n){
    if(!catalog.get(name)?.found)throw Error('Forge 没有这张已公开的牌：'+name);
    const fromSideboard=(side.get(name)||0)>0;
    const removed=fromSideboard||total(pool)>=size?removeSpare(!!catalog.get(name)?.land,fromSideboard):null;
    if(!removed&&total(pool)>=size)throw Error('固定牌表无法容纳整局公开牌。');
    pool.set(name,(pool.get(name)||0)+1);
    if(fromSideboard){side.set(name,side.get(name)-1);if(removed)side.set(removed,(side.get(removed)||0)+1);}
    adjustments.push({removed,added:name,basis:fromSideboard?'whole-game public evidence; moved from reference sideboard':'whole-game public evidence; inferred list correction'});
  }
  while(total(pool)>size){
    const removed=removeSpare(false);
    if(!removed)throw Error('无法在保留整盘公开牌的前提下缩减主牌至 '+size+' 张。');
    adjustments.push({removed,added:null,basis:'recorded starting main-deck count'});
  }
  while(total(pool)<size){
    const available=[...pool.keys()].filter(name=>pool.get(name)>0&&((pool.get(name)||0)+(side.get(name)||0)<4||/^Basic\s+Land\b/.test(catalog.get(name)?.type||'')));
    available.sort((a,b)=>Number(matchMinimum.has(a))-Number(matchMinimum.has(b))||Number(!!catalog.get(b)?.land)-Number(!!catalog.get(a)?.land));
    const added=available[0];if(!added)throw Error('无法恢复固定主牌张数。');
    pool.set(added,pool.get(added)+1);adjustments.push({removed:null,added,basis:'recorded starting main-deck count; hypothetical slot'});
  }
  if(adjustments.length>Math.ceil(size*.2))throw Error('相近牌表与整局公开信息差异过大。');
  return{...base,main:[...pool].filter(([,n])=>n>0).map(([name,count])=>({name,count})),sideboard:[...side].filter(([,n])=>n>0).map(([name,count])=>({name,count})),adjustments,fixedForGame:true,deckInformationScope:'entire replay visible information',hypothesisId:hash({pool:[...pool],side:[...side],source:base.sha256})};
}
function coverGlobalFacts(base,observed,catalog,size=base.main.reduce((n,c)=>n+c.count,0)){
  const main=mapCounts(base.main),side=mapCounts(base.sideboard),minimum=mapCounts(observed),adjustments=[...(base.adjustments||[])];
  for(const [name,required] of minimum)while((main.get(name)||0)+(side.get(name)||0)<required){
    const zone=(main.get(name)||0)>=(side.get(name)||0)?main:side;
    if(zone===main&&total(main)<size){
      main.set(name,(main.get(name)||0)+1);
      adjustments.push({removed:null,added:name,zone:'main',basis:'recorded starting main-deck count; whole-replay public evidence'});
      continue;
    }
    const candidates=[...zone].filter(([card,n])=>n>0&&(main.get(card)||0)+(side.get(card)||0)>(minimum.get(card)||0));
    candidates.sort((a,b)=>Number(!!catalog.get(b[0])?.land===!!catalog.get(name)?.land)-Number(!!catalog.get(a[0])?.land===!!catalog.get(name)?.land)||b[1]-a[1]||a[0].localeCompare(b[0]));
    if(!candidates.length)throw Error('相近牌表无法容纳整盘公开信息。');
    const removed=candidates[0][0];zone.set(removed,zone.get(removed)-1);zone.set(name,(zone.get(name)||0)+1);
    adjustments.push({removed,added:name,zone:zone===main?'main':'sideboard',basis:'whole-replay public minimum exceeds published reference count; inferred flex-slot correction'});
  }
  const list=m=>[...m].filter(([,n])=>n>0).map(([name,count])=>({name,count}));return{...base,main:list(main),sideboard:list(side),adjustments};
}
function validateUpload(deck,player,first,recorded){
  const main=mapCounts(deck.main),all=new Map(main),id=player.playerId;
  const expected=first.initialDeckSizes[id];
  if(expected&&total(main)!==expected)throw Error('上传的主牌有 '+total(main)+' 张，回放起始主牌有 '+expected+' 张。');
  for(const [name,count] of mapCounts(deck.sideboard))all.set(name,(all.get(name)||0)+count);
  const firstCards=counts([...(first.players.get(id)?.values()||[])].map(c=>c.name));
  for(const [cards,available,label] of [[firstCards,main,'第一局主牌'],[player.cards,all,'整盘主备牌']]){
    const missing=cards.filter(c=>(available.get(c.name)||0)<c.count);
    if(missing.length)throw Error(label+'缺少回放已出现的 '+missing.map(c=>c.count+' × '+c.name).join('、')+'。');
  }
  for(const [key,knownDeck] of recorded)if(key.endsWith(':'+id)){
    const known=counts(knownDeck.main.concat(knownDeck.sideboard).flatMap(c=>Array(c.count).fill(c.name.split(' // ')[0])));
    if(total(all)!==known.reduce((n,c)=>n+c.count,0)||known.some(c=>all.get(c.name)!==c.count))throw Error('上传的主备牌组成与回放中完整记录的牌池不一致。');
  }
}
function readManualSideboard(value){
  if(value==null)return [];
  if(!Array.isArray(value)||value.length>18)throw Error('手动换备设置无效。');
  const keys=new Set();
  return value.map(entry=>{
    if(!entry||!Number.isInteger(entry.game)||entry.game<2||!['0','1'].includes(entry.playerId))throw Error('请选择有效的换备局数和玩家。');
    const key=entry.game+':'+entry.playerId;
    if(keys.has(key))throw Error('同一局同一玩家只能有一份换备设置。');
    keys.add(key);
    function parse(text){
      if(typeof text!=='string'||text.length>4000)throw Error('请逐行填写换备数量和完整英文牌名。');
      const names=[];
      for(const line of text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)){
        const match=/^([1-9]\d?)\s+(.+)$/.exec(line);
        if(!match||Number(match[1])+names.length>15)throw Error('换备每行格式如 2 Pyroblast，每边最多 15 张。');
        names.push(...Array(Number(match[1])).fill(canonicalName(match[2])));
      }
      return counts(names);
    }
    const ins=parse(entry.inText),outs=parse(entry.outText);
    if(ins.reduce((n,c)=>n+c.count,0)!==outs.reduce((n,c)=>n+c.count,0))throw Error('手动换入和换出的总张数必须相同。');
    return {game:entry.game,playerId:entry.playerId,ins,outs,manual:true,reason:'玩家指定换备',uncertainties:[]};
  });
}
function descriptionDeckPreferences(header){
  const meta=header.branchMeta;
  if(meta?.format!=='endstep-forge-search-branch'||meta.version!==1||meta.sourceKind!=='description'||!Array.isArray(meta.assumptions))return null;
  try{
    const inputs=Object.fromEntries(['0','1'].map(id=>{
      const matches=meta.assumptions.filter(a=>a?.id==='deck-'+id&&String(a.playerId)===id);
      if(matches.length!==1)throw Error('Missing branch deck');
      const {mainDeck,sideboard}=matches[0];
      const encode=cards=>{
        if(!Array.isArray(cards)||cards.length>150)throw Error('Invalid branch deck');
        return cards.map(c=>{
          if(!Number.isInteger(c?.count)||c.count<1||typeof c.name!=='string'||/[\r\n;|]/.test(c.name))throw Error('Invalid branch deck card');
          return c.count+' '+c.name;
        }).join('\n');
      };
      return [id,{mode:'upload',text:encode(mainDeck)+'\nSideboard\n'+encode(sideboard)}];
    }));
    const preferences=readDeckPreferences(inputs);
    for(const {deck} of Object.values(preferences))Object.assign(deck,{
      sourceKind:'branch-deck',archetype:'推演使用的牌表',basis:'来自此 Forge 推演文件的牌表；已核对记录中的牌名、张数和可见牌。'
    });
    return preferences;
  }catch{return null;}
}
async function prepareMatchDecks({model,deckService,forge,ask,signal,deckPreferences=null,manualSideboard=[],onProgress=()=>{}}){
  const scanned=scanMatch(model.sourceText),bases=[];
  const first=[...scanned.games.values()][0];
  if(!first)throw Error('回放没有可用于核对起始牌表的对局。');
  const embedded=descriptionDeckPreferences(scanned.header);
  if(embedded){
    deckPreferences={...deckPreferences};
    for(const id of ['0','1'])if(!deckPreferences[id]||deckPreferences[id].mode==='local')deckPreferences[id]=embedded[id];
  }
  const allowWeb=!deckPreferences||Object.values(deckPreferences).some(p=>p.mode==='web');
  const label=id=>String(id)===String(scanned.header.seat)?'己方':'对手';
  for(const player of scanned.global){
    const uploaded=deckPreferences?.[player.playerId]?.deck;
    if(uploaded)try{validateUpload(uploaded,player,first,scanned.recorded);}
    catch(error){throw new DeckLookupError('deck_upload_invalid',label(player.playerId)+' · '+error.message);}
  }
  for(const player of scanned.global){
    const preference=deckPreferences?.[player.playerId];
    if(preference?.mode==='upload'){bases.push(preference.deck);continue;}
    const recorded=scanned.recorded.get('1:'+player.playerId);
    if(recorded){bases.push(recorded);continue;}
    const known=player.cards.flatMap(c=>Array.from({length:c.count},(_,i)=>({id:c.name+':'+i,name:c.name,ownerId:player.playerId})));
    try{
      bases.push(await deckService.resolve({source:{known,initialDeckSizes:first.initialDeckSizes,game:1,global:true,format:scanned.header.formatId||'Legacy',recordedAt:scanned.header.recordedAt},playerId:player.playerId,mode:preference?.mode||(deckPreferences?'local':'auto'),ask,signal,onProgress:message=>onProgress(label(player.playerId)+' · '+message)}));
    }catch(error){if(signal?.aborted)throw error;throw new DeckLookupError(error instanceof DeckLookupError?error.code:'deck_lookup_failed',label(player.playerId)+' · '+error.message);}
  }
  const names=[...new Set(bases.concat([...scanned.recorded.values()]).flatMap(d=>d.main.concat(d.sideboard)).map(c=>c.name.split(' // ')[0]).concat(scanned.global.flatMap(p=>p.cards.map(c=>c.name))))];
  const meta=await forge.request({command:'catalog',names},{signal}),catalog=new Map(meta.cards.map(c=>[c.name,c]));
  const missing=meta.cards.filter(c=>!c.found);
  if(missing.length){
    const uploaded=bases.filter(d=>d.sourceKind==='uploaded').flatMap(d=>d.main.concat(d.sideboard));
    const unknownUploads=missing.filter(c=>uploaded.some(d=>d.name===c.name));
    const hint='。请核对英文牌名，若是新牌，可在「Forge 引擎」检查正式版。';
    if(unknownUploads.length)throw new DeckLookupError('deck_upload_invalid','Forge 无法识别上传牌名 '+unknownUploads.map(c=>c.name).join('、')+hint);
    throw Error('Forge 数据库缺少牌面：'+missing.map(c=>c.name).join('；')+hint);
  }
  const fixedBases=bases.map((base,i)=>{
    const matchObserved=scanned.global[i].cards;
    const firstObserved=counts([...(first.players.get(String(i))?.values()||[])].map(c=>c.name));
    const size=first.initialDeckSizes[String(i)]||base.main.reduce((n,c)=>n+c.count,0);
    return fixDeck(coverGlobalFacts(base,matchObserved,catalog,size),firstObserved,size,catalog,matchObserved);
  });
  const later=[...scanned.games.values()].filter(g=>g.game>first.game);
  function applyPlan(base,plan){
    const main=mapCounts(base.main),side=mapCounts(base.sideboard);
    if(plan.ins.reduce((n,c)=>n+c.count,0)!==plan.outs.reduce((n,c)=>n+c.count,0))throw Error('换入换出数量不同。');
    for(const c of plan.ins)if((side.get(c.name)||0)<c.count||plan.outs.some(o=>o.name===c.name))throw Error('原备牌没有足够可换入的 '+c.name);
    for(const c of plan.outs)if((main.get(c.name)||0)<c.count)throw Error('原主牌没有足够可换出的 '+c.name);
    for(const [moves,from,to] of [[plan.outs,main,side],[plan.ins,side,main]])for(const c of moves){
      const name=canonicalName(c.name);if(!Number.isInteger(c.count)||c.count<1||(from.get(name)||0)<c.count)throw Error('换备来源没有足够的 '+name);
      from.set(name,from.get(name)-c.count);to.set(name,(to.get(name)||0)+c.count);
    }
    const list=m=>[...m].filter(([,n])=>n>0).map(([name,count])=>({name,count}));
    return{...base,main:list(main),sideboard:list(side),sideboardPlan:plan,fixedForGame:true,hypothesisId:hash({main:[...main],side:[...side],source:base.sha256,plan})};
  }
  function checkPlan(game,id,plan){
    const deck=applyPlan(fixedBases[Number(id)],plan);
    if(plan.manual||!scanned.recorded.has(game.game+':'+id)){
      const main=mapCounts(deck.main),minimum=counts([...(game.players.get(id)?.values()||[])].map(c=>c.name));
      for(const card of minimum)if((main.get(card.name)||0)<card.count)throw Error('第 '+game.game+' 局换备后没有足够的已公开牌 '+card.name);
    }
  }
  for(const plan of manualSideboard){
    const game=later.find(g=>g.game===plan.game);
    if(!game)throw Error('回放中没有第 '+plan.game+' 局的换备节点。');
    try{checkPlan(game,plan.playerId,plan);}
    catch(error){throw Error('第 '+plan.game+' 局 '+label(plan.playerId)+'手动换备 · '+error.message);}
  }
  const pending=later.flatMap(g=>['0','1'].filter(id=>!manualSideboard.some(p=>p.game===g.game&&p.playerId===id)).map(id=>({game:g.game,playerId:id})));
  let plans=[...manualSideboard];
  if(pending.length){
    let repair='';
    for(let attempt=0;attempt<2;attempt++){
      onProgress('正在结合双方完整牌表推理换备方案…');
      const sources=allowWeb?'可使用联网搜索查找公开换备指南。使用网页时在 reason 中列出原始链接，区分资料与推理。':'根据给出的牌表与已公开牌自行推理。';
      const response=await ask(`你是万智牌比赛换备教练。根据双方固定的完整主牌和备牌，推理后续各局的换备。${sources}不得编造引用。所有换入/换出均相对于提供的基准主备牌，保留主牌张数，不能创造牌或超出实体数量。只对 pending 中每个 game 和 playerId 各给一份方案。manualSideboard 是已经锁定的玩家设置。swaps 每项为同数量的替换，从原备牌换入、从原主牌换出，允许不换牌的空数组。方案必须容纳该局公开牌。已有实际记录时仍给建议对照。未知灵活位明确是不确定假设。\n`+JSON.stringify({pending,manualSideboard,players:scanned.header.players,baseDecks:fixedBases.map((d,i)=>({playerId:String(i),main:d.main,sideboard:d.sideboard,source:d.basis})),games:later.map(g=>({game:g.game,startingPlayerId:g.startingPlayerId,publicMinimums:['0','1'].map(id=>({playerId:id,cards:counts([...(g.players.get(id)?.values()||[])].map(c=>c.name))})),recordedViewerDeck:scanned.recorded.get(g.game+':'+String(scanned.header.seat))||null}))})+repair,Schema.sideboarding,{webSearch:allowWeb});
      validate(response,Schema.sideboarding);
      response.plans=response.plans.map(plan=>({...plan,ins:counts(plan.swaps.flatMap(s=>Array(s.count).fill(s.inName))),outs:counts(plan.swaps.flatMap(s=>Array(s.count).fill(s.outName)))}));
      try{
        for(const {game,playerId} of pending){
          const matches=response.plans.filter(p=>p.game===game&&p.playerId===playerId);if(matches.length!==1)throw Error('后续局缺少唯一的换备方案。');
          checkPlan(later.find(g=>g.game===game),playerId,matches[0]);
          plans.push(matches[0]);
        }
        break;
      }catch(error){plans=[...manualSideboard];repair='\n上次换备核对失败：'+error.message+'。请修正完整方案。';if(attempt===1)throw error;}
    }
  }
  const byGame={};
  for(const g of scanned.games.values())byGame[g.game]=['0','1'].map((id,i)=>{
    const actual=scanned.recorded.get(g.game+':'+id),plan=plans.find(p=>p.game===g.game&&p.playerId===id);
    if(actual&&!plan?.manual)return{...fixDeck(actual,counts([...(g.players.get(id)?.values()||[])].map(c=>c.name)),g.initialDeckSizes[id],catalog),recommendedSideboardPlan:plan||null};
    return plan?applyPlan(fixedBases[i],plan):fixedBases[i];
  });
  return{byGame,catalog,bases:fixedBases,sideboardPlans:plans,manualSideboard,scope:scanned.scope,globalObserved:scanned.global};
}
module.exports={scanMatch,fixDeck,coverGlobalFacts,prepareMatchDecks,readManualSideboard,descriptionDeckPreferences};
