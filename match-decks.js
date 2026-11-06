'use strict';
const crypto=require('node:crypto');
const R=require('./replay');
const {canonicalName}=require('./deck-service');
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
    const key=game+':'+id+':'+c.id;if(!c.isTransformed&&!c.isBackFace)faces.set(key,c.name.split(' // ')[0]);
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
      for(const c of state.pendingAction?.cardOptions||[])remember(c,c.ownerId??state.players.find(p=>p.name===c.ownerName)?.id??viewer);
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
function fixDeck(base,observed,size,catalog){
  const pool=mapCounts(base.main),side=mapCounts(base.sideboard),required=mapCounts(observed),adjustments=[...(base.adjustments||[])];
  function removeSpare(preferLand){
    const spare=[...pool].filter(([name,n])=>n>(required.get(name)||0));
    if(!spare.length)throw Error('固定牌表无法容纳整局公开牌。');
    spare.sort((a,b)=>Number(!!catalog.get(b[0])?.land===preferLand)-Number(!!catalog.get(a[0])?.land===preferLand)||b[1]-a[1]||a[0].localeCompare(b[0]));
    const name=spare[0][0];pool.set(name,pool.get(name)-1);return name;
  }
  for(const [name,n] of required)while((pool.get(name)||0)<n){
    if(!catalog.get(name)?.found)throw Error('Forge 没有这张已公开的牌：'+name);
    const removed=removeSpare(!!catalog.get(name)?.land);pool.set(name,(pool.get(name)||0)+1);
    const fromSideboard=(side.get(name)||0)>0;if(fromSideboard){side.set(name,side.get(name)-1);side.set(removed,(side.get(removed)||0)+1);}
    adjustments.push({removed,added:name,basis:fromSideboard?'whole-game public evidence; assumed sideboard swap':'whole-game public evidence; inferred list correction'});
  }
  while(total(pool)>size){const removed=removeSpare(false);adjustments.push({removed,added:null,basis:'recorded starting main-deck count'});}
  while(total(pool)<size){const added=base.main.find(c=>!required.has(c.name))?.name;if(!added)throw Error('无法恢复固定主牌张数。');pool.set(added,(pool.get(added)||0)+1);adjustments.push({removed:null,added,basis:'recorded starting main-deck count; hypothetical slot'});}
  if(adjustments.length>Math.ceil(size*.2))throw Error('相近牌表与整局公开信息差异过大。');
  return{...base,main:[...pool].filter(([,n])=>n>0).map(([name,count])=>({name,count})),sideboard:[...side].filter(([,n])=>n>0).map(([name,count])=>({name,count})),adjustments,fixedForGame:true,deckInformationScope:'entire replay visible information',hypothesisId:hash({pool:[...pool],side:[...side],source:base.sha256})};
}
function coverGlobalFacts(base,observed,catalog){
  const main=mapCounts(base.main),side=mapCounts(base.sideboard),minimum=mapCounts(observed),adjustments=[...(base.adjustments||[])];
  for(const [name,required] of minimum)while((main.get(name)||0)+(side.get(name)||0)<required){
    const zone=(main.get(name)||0)>=(side.get(name)||0)?main:side;
    const candidates=[...zone].filter(([card,n])=>n>0&&(main.get(card)||0)+(side.get(card)||0)>(minimum.get(card)||0));
    candidates.sort((a,b)=>Number(!!catalog.get(b[0])?.land===!!catalog.get(name)?.land)-Number(!!catalog.get(a[0])?.land===!!catalog.get(name)?.land)||b[1]-a[1]||a[0].localeCompare(b[0]));
    if(!candidates.length)throw Error('相近牌表的75张牌无法容纳整盘公开信息。');
    const removed=candidates[0][0];zone.set(removed,zone.get(removed)-1);zone.set(name,(zone.get(name)||0)+1);
    adjustments.push({removed,added:name,zone:zone===main?'main':'sideboard',basis:'whole-replay public minimum exceeds published reference count; inferred flex-slot correction'});
  }
  const list=m=>[...m].filter(([,n])=>n>0).map(([name,count])=>({name,count}));return{...base,main:list(main),sideboard:list(side),adjustments};
}
async function prepareMatchDecks({model,deckService,forge,ask,signal,onProgress=()=>{}}){
  const scanned=scanMatch(model.sourceText),bases=[];
  for(const player of scanned.global){
    const recorded=scanned.recorded.get('1:'+player.playerId);
    if(recorded){bases.push(recorded);continue;}
    const known=player.cards.flatMap(c=>Array.from({length:c.count},(_,i)=>({id:c.name+':'+i,name:c.name,ownerId:player.playerId})));
    const initial=Object.fromEntries([...scanned.games.values()][0]?.initialDeckSizes?Object.entries([...scanned.games.values()][0].initialDeckSizes):[]);
    bases.push(await deckService.resolve({source:{known,initialDeckSizes:initial,game:1,global:true,deckFacts:player.cards},playerId:player.playerId,ask,signal,onProgress}));
  }
  const names=[...new Set(bases.concat([...scanned.recorded.values()]).flatMap(d=>d.main.concat(d.sideboard)).map(c=>c.name.split(' // ')[0]).concat(scanned.global.flatMap(p=>p.cards.map(c=>c.name))))];
  const meta=await forge.request({command:'catalog',names},{signal}),catalog=new Map(meta.cards.map(c=>[c.name,c]));
  const missing=meta.cards.filter(c=>!c.found);if(missing.length)throw Error('Forge 数据库缺少牌面：'+missing.map(c=>c.name).join('；'));
  const first=[...scanned.games.values()][0];
  const fixedBases=bases.map((base,i)=>fixDeck(coverGlobalFacts(base,scanned.global[i].cards,catalog),counts([...(first.players.get(String(i))?.values()||[])].map(c=>c.name)),first.initialDeckSizes[String(i)]||base.main.reduce((n,c)=>n+c.count,0),catalog));
  const later=[...scanned.games.values()].filter(g=>g.game>first.game);let plans=[];
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
  if(later.length){
    let repair='';
    for(let attempt=0;attempt<2;attempt++){
      onProgress('正在结合双方完整牌表推理换备方案…');
      const response=await ask(`你是万智牌比赛换备教练。根据双方固定的完整主牌和备牌，推理后续各局的换备。可使用联网搜索查找该对局的公开换备指南；若实际使用网页，在reason中列出支持结论的原始链接，并区分资料建议与自己的推理。没有找到资料也可自行推理，不得编造引用。所有换入/换出均相对于提供的基准主备牌，保留主牌张数，不能创造牌或超出实体数量。结合对局类型、先后手、每局已公开牌的最低数量，给每个后续game的每个playerId一份方案。swaps每项为同数量的成对替换：inName从原备牌进入、outName从原主牌离开、count为两者相同数量；可拆成多项，允许不换牌的空数组。这样接口保证总数相等。不能换入不在原备牌中的牌，不能把本次刚换出的牌算成可换入来源。对手方案必须容纳该局公开牌。录制侧实际换备另有精确记录时，你仍给建议对照，程序会保留实际牌表作事实。两份完整牌表允许用于匹配分析，不能声称对手知道我们的实际换备或手牌。未知灵活位明确是不确定假设。\n`+JSON.stringify({players:scanned.header.players,baseDecks:fixedBases.map((d,i)=>({playerId:String(i),main:d.main,sideboard:d.sideboard,source:d.basis})),games:later.map(g=>({game:g.game,startingPlayerId:g.startingPlayerId,publicMinimums:['0','1'].map(id=>({playerId:id,cards:counts([...(g.players.get(id)?.values()||[])].map(c=>c.name))})),recordedViewerDeck:scanned.recorded.get(g.game+':'+String(scanned.header.seat))||null}))})+repair,Schema.sideboarding,{webSearch:true});
      validate(response,Schema.sideboarding);
      response.plans=response.plans.map(plan=>({...plan,ins:counts(plan.swaps.flatMap(s=>Array(s.count).fill(s.inName))),outs:counts(plan.swaps.flatMap(s=>Array(s.count).fill(s.outName)))}));
      try{
        for(const g of later)for(const id of ['0','1']){
          const matches=response.plans.filter(p=>p.game===g.game&&p.playerId===id);if(matches.length!==1)throw Error('后续局缺少唯一的换备方案。');
          const deck=applyPlan(fixedBases[Number(id)],matches[0]);
          if(!scanned.recorded.has(g.game+':'+id)){
            const main=mapCounts(deck.main),minimum=counts([...(g.players.get(id)?.values()||[])].map(c=>c.name));
            for(const c of minimum)if((main.get(c.name)||0)<c.count)throw Error('第 '+g.game+' 局换备后没有足够的已公开牌 '+c.name);
          }
        }
        plans=response.plans;break;
      }catch(error){repair='\n上次换备核对失败：'+error.message+'。请修正完整方案。';if(attempt===1)throw error;}
    }
  }
  const byGame={};
  for(const g of scanned.games.values())byGame[g.game]=['0','1'].map((id,i)=>{
    const actual=scanned.recorded.get(g.game+':'+id),plan=plans.find(p=>p.game===g.game&&p.playerId===id);
    if(actual)return{...fixDeck(actual,counts([...(g.players.get(id)?.values()||[])].map(c=>c.name)),g.initialDeckSizes[id],catalog),recommendedSideboardPlan:plan||null};
    return plan?applyPlan(fixedBases[i],plan):fixedBases[i];
  });
  return{byGame,catalog,bases:fixedBases,sideboardPlans:plans,scope:scanned.scope,globalObserved:scanned.global};
}
module.exports={scanMatch,fixDeck,coverGlobalFacts,prepareMatchDecks};
