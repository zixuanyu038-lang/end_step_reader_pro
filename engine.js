(function(root){
 'use strict';
 const clone=x=>JSON.parse(JSON.stringify(x));
 const SUPPORTED=['Tamiyo, Inquisitive Student','Brainstorm','Ponder','Flame of Anor','Swords to Plowshares'];
 const ACTIONS=['advance_main','play_land','cast','resolve_top','activate_fetch','resolve_fetch'];
 class Stop extends Error{constructor(code,message){super(message);this.code=code;}}
 const fail=(s)=>{throw new Stop('invalid_action',s);};
 const unsupported=(s)=>{throw new Stop('unsupported_rule',s);};
 const unknown=s=>{throw new Stop('unknown_outcome',s);};
 const fields={hand:'Hand',battlefield:'Battlefield',graveyard:'Graveyard',exile:'Exile'};
 function find(s,id){for(const p of s.players)for(const z of Object.keys(fields)){const c=(p[z]||[]).find(c=>String(c.id)===String(id));if(c)return {p,z,c};}return null;}
 const board=s=>s.players.flatMap(p=>p.battlefield||[]);
 const wizard=p=>(p.battlefield||[]).some(c=>!c.isPhasedOut&&(c.subtypes||[]).includes('Wizard'));
 const named=(c,name)=>(c.chosenMarks||[]).some(m=>m.kind==='NAME'&&m.value===name);
 function move(found,to){found.p[found.z]=found.p[found.z].filter(c=>c.id!==found.c.id);found.c.zone=fields[to];found.p[to]||=[];found.p[to].push(found.c);found.p.handSize=found.p.hand.length;}
 function manaColors(s,c){
   if(!c.types?.includes('Land'))fail('第一版仅支持使用地支付法术力。');
   if(c.tapped||c.isPhasedOut)fail(c.name+' 当前不能横置产费。');
   let subs=c.subtypes||[];
   if(board(s).some(x=>['Magus of the Moon','Blood Moon'].includes(x.name))&&!c.supertypes?.includes('Basic'))subs=['Mountain'];
   const colors={Plains:'W',Island:'U',Swamp:'B',Mountain:'R',Forest:'G'};
   const result=subs.map(t=>colors[t]).filter(Boolean);if(!result.length)unsupported('暂不支持此地的产费规则：'+c.name);return result;
 }
 function pay(s,p,c,payment,ctx){
   if(!Array.isArray(payment)||!payment.length)fail('cast 必须明确列出 payment（landId、color）。');
   const cost=c.manaCost||'';if(!/^(?:\{(?:\d+|[WUBRGC])\})+$/.test(cost))unsupported('暂不支持该费用或替代费用：'+cost);
   const symbols=[...cost.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]),required={};let generic=0;
   for(const sym of symbols)if(/^\d+$/.test(sym))generic+=Number(sym);else required[sym]=(required[sym]||0)+1;
   for(const b of board(s)){
     if(b.name==='Disruptor Flute'&&named(b,c.name))generic+=3;
     if(b.name==='Damping Sphere')generic+=ctx.casts[String(p.id)]||0;
   }
   let total=generic+Object.values(required).reduce((a,b)=>a+b,0);
   if(board(s).some(b=>b.name==='Trinisphere'&&!b.tapped)){generic+=Math.max(0,3-total);total=Math.max(3,total);}
   const pool={...(p.manaPool||{})};const ids=new Set();
   for(const x of payment){
     if(!x||typeof x!=='object'||!['W','U','B','R','G','C'].includes(x.color)||ids.has(String(x.landId)))fail('支付来源或颜色无效，或重复横置同一块地。');ids.add(String(x.landId));
     const f=find(s,x.landId);if(!f||f.p.id!==p.id||f.z!=='battlefield')fail('支付来源不在己方战场。');
     if(!manaColors(s,f.c).includes(x.color))fail(f.c.name+' 不能产生 '+x.color);f.c.tapped=true;pool[x.color]=(pool[x.color]||0)+1;
   }
   for(const [color,n] of Object.entries(required)){if((pool[color]||0)<n)fail('缺少 '+color+' 色法术力。');pool[color]-=n;}
   for(const color of Object.keys(pool)){const n=Math.min(generic,pool[color]);pool[color]-=n;generic-=n;}
   if(generic)fail('法术力不足。');p.manaPool=Object.fromEntries(Object.entries(pool).filter(([,v])=>v));
 }
 function legalCard(s,p,id){const f=find(s,id);if(!f||f.p.id!==p.id||f.z!=='hand'||f.c.faceDown)fail('使用的牌不在己方已知手牌中。');return f;}
 function push(s,c,p,text,ability=false,extra={}){s.stack.unshift({sourceCard:clone(c),sourceCardZone:c.zone,controllerId:p.id,isAbility:ability,isTrigger:false,abilityDescription:text,targets:[],stackTargetId:-700000000+(s.sequenceNumber||0),...extra});}
 function draw(s,p,count,ctx){
   if(!ctx.drawCountKnown)unsupported('此分歧点之前的抓牌次数不能可靠还原，暂停Tamiyo, Inquisitive Student相关抓牌结算。');
   const top=p.libraryTop||[];if(top.length<count||top.slice(0,count).some(c=>!c.name||c.name==='Hidden card'||c.faceDown))unknown('牌库顶不足 '+count+' 张已知牌；停止在抽牌效果结算之前，不使用原局未来抓牌。');
   for(const c of top.slice(0,count))if(find(s,c.id))fail('牌库顶的牌已出现在其他区域。');
   const n=ctx.drawn||0;
   for(const original of top.slice(0,count)){const c=clone(original);c.zone='Hand';c.ownerId=p.id;c.controllerId=p.id;p.hand.push(c);p.librarySize--;}
   p.libraryTop=top.slice(count);p.handSize=p.hand.length;ctx.drawn=n+count;
   if(n<3&&n+count>=3){const t=p.battlefield.find(c=>c.name==='Tamiyo, Inquisitive Student');if(t)push(s,t,p,'Tamiyo, Inquisitive Student：本回合第三次抓牌，放逐并转化移回战场。',true,{isTrigger:true,_localEffect:'tamiyo_transform'});}
 }
 function target(s,id,type){const f=find(s,id);if(!f||f.z!=='battlefield'||f.c.isPhasedOut||f.c.faceDown||!f.c.types?.includes(type))fail('目标不是有效的'+type+'。');
   if((f.c.keywords||[]).some(k=>/Ward|Hexproof|Shroud|Protection|Indestructible/i.test(k)))fail('目标具有暂未支持的防护或额外目标规则。');return f;}
 function apply(base,a,context){
   if(!a||!ACTIONS.includes(a.type)||typeof a.type!=='string')fail('不支持的动作接口：'+a?.type);
   const allowed={advance_main:['type'],play_land:['type','cardId'],cast:['type','cardId','payment','modes','drawPlayerId','artifactId','creatureId'],resolve_top:['type'],activate_fetch:['type','cardId'],resolve_fetch:['type','landId']}[a.type];
   if(Object.keys(a).some(k=>!allowed.includes(k)))fail('动作含有接口未定义的字段。');
   for(const key of ['cardId','landId','artifactId','creatureId'])if(a[key]!=null&&(!Number.isSafeInteger(a[key])||a[key]<0))fail('牌 ID 必须是非负安全整数。');
   if(a.payment!=null&&(!Array.isArray(a.payment)||a.payment.some(x=>!x||Object.keys(x).some(k=>!['landId','color'].includes(k))||!Number.isSafeInteger(x.landId))))fail('payment 不符合动作接口。');
   const s=clone(base),ctx=clone(context),p=s.players.find(p=>String(p.id)===String(ctx.seat));if(!p)fail('录制座位不存在。');
   const events=[];s.stack||=[];
   if(a.type==='advance_main'){
     if(String(s.activePlayerId)!==String(p.id)||s.stack.length||!['UNTAP','UPKEEP','DRAW','MAIN1'].includes(s.phase))fail('只能从己方开始阶段、空堆叠进入第一主阶段。');
     if(!ctx.assumed)unknown('推进到主阶段需要假设对手在期间不采取其他行动。');
     s.phase='MAIN1';s.step='MAIN1';s.priorityPlayerId=p.id;events.push({type:'TURN_PHASE',phase:'MAIN1',playerName:p.name,playerIndex:p.id,message:'进入第一主阶段。'});
   }
   if(a.type==='play_land'){
     if(!['MAIN1','MAIN2'].includes(s.phase)||String(s.activePlayerId)!==String(p.id)||s.stack.length)fail('当前不是可以下地的时机。');
     if(ctx.landsPlayed)fail('本回合已经下过地；暂不支持额外下地效果。');
     const f=legalCard(s,p,a.cardId);if(!f.c.types?.includes('Land'))fail('目标不是地牌。');
     if(!f.c.supertypes?.includes('Basic')&&!['Plateau','Tundra','Volcanic Island','Flooded Strand','Scalding Tarn','Prismatic Vista'].includes(f.c.name))fail('暂未实现此地的进场规则。');
     move(f,'battlefield');f.c.tapped=false;ctx.landsPlayed++;events.push({type:'LAND_PLAYED',cardName:f.c.name,cardId:f.c.id,playerName:p.name,playerIndex:p.id,message:p.name+' 下地 '+f.c.name});
   }
   if(a.type==='cast'){
     const f=legalCard(s,p,a.cardId),c=f.c;if(!SUPPORTED.includes(c.name))unsupported('尚未实现此牌的规则处理器：'+c.name);
     if(board(s).some(b=>b.name==='Chalice of the Void'&&Number(b.counters?.Charge)===Number(c.cmc)))unsupported('此处会触发 Chalice，暂未实现该触发的完整处理。');
     if(String(s.priorityPlayerId)!==String(p.id))fail('己方当前没有优先权。');
     if(!c.types?.includes('Instant')&&(!['MAIN1','MAIN2'].includes(s.phase)||String(s.activePlayerId)!==String(p.id)||s.stack.length))fail('非瞬间牌必须在己方主阶段、空堆叠时施放。');
     let modes=[];if(c.name==='Flame of Anor'){
       modes=a.modes;if(!Array.isArray(modes)||!modes.length||modes.length>(wizard(p)?2:1)||new Set(modes).size!==modes.length||modes.some(m=>!['draw_two','destroy_artifact','damage_creature'].includes(m)))fail('Flame of Anor 的模式数量或模式不合法。');
       if(modes.includes('draw_two')&&String(a.drawPlayerId)!==String(p.id))fail('第一版只支持 Flame of Anor 让己方抓牌。');
       if(modes.includes('destroy_artifact'))target(s,a.artifactId,'Artifact');if(modes.includes('damage_creature'))target(s,a.creatureId,'Creature');
     }
     if(c.name==='Swords to Plowshares')target(s,a.creatureId,'Creature');
     pay(s,p,c,a.payment,ctx);p.hand=p.hand.filter(x=>x.id!==c.id);p.handSize=p.hand.length;c.zone='Stack';ctx.casts[String(p.id)]=(ctx.casts[String(p.id)]||0)+1;s.stormCount=(s.stormCount||0)+1;
     push(s,c,p,c.name,false,{_localAction:clone(a)});events.push({type:'SPELL_CAST',cardName:c.name,cardId:c.id,playerName:p.name,playerIndex:p.id,message:p.name+' 施放 '+c.name});
   }
   if(a.type==='resolve_top'){
     if(!ctx.assumed)unknown('结算堆叠需要明确假设对手不响应。');
     const item=s.stack[0];if(!item)fail('堆叠为空。');
     const owner=s.players.find(p=>p.id===item.controllerId);if(!owner)fail('堆叠操控者不存在。');
     if(item._localEffect==='tamiyo_transform'){
       const f=find(s,item.sourceCard.id);if(!f||f.z!=='battlefield'||f.c.name!=='Tamiyo, Inquisitive Student')fail('Tamiyo, Inquisitive Student转化来源已不在战场。');
       s.stack.shift();f.c.name='Tamiyo, Seasoned Scholar';f.c.types=['Planeswalker'];f.c.subtypes=['Tamiyo'];f.c.power=0;f.c.toughness=0;f.c.counters={Loyalty:2};f.c.isTransformed=true;f.c.isBackFace=true;f.c.hasSummoningSickness=false;f.c.tapped=false;f.c.oracleText=f.c.alternateOracleText||'';
     }else{
       const c=item.sourceCard,a=item._localAction;if(!a||item.isAbility)fail('暂不能结算原局遗留的异能；请选择空堆叠分歧点。');
       if(c.name==='Brainstorm')unknown('Brainstorm 的抓三、放回两张尚未完整接入；第一版停在结算前，不生成未知抓牌或不完整结算。');
       if(c.name==='Ponder')unknown('Ponder 的检视与牌序选择尚未接入执行器，停在结算前。');
       s.stack.shift();
       if(c.name==='Tamiyo, Inquisitive Student'){
         c.zone='Battlefield';c.tapped=false;c.hasSummoningSickness=true;c.isAttacking=false;c.isBlocking=false;owner.battlefield.push(c);
       }else if(c.name==='Flame of Anor'){
         if(a.modes.includes('draw_two'))draw(s,owner,2,ctx);
         if(a.modes.includes('destroy_artifact')){const f=target(s,a.artifactId,'Artifact');if((f.c.abilities||[]).some(x=>/dies|graveyard|leaves/i.test(x)))fail('目标有尚未支持的离场效应。');move(f,'graveyard');}
         if(a.modes.includes('damage_creature')){const f=target(s,a.creatureId,'Creature');f.c.damage=(f.c.damage||0)+5;if(f.c.damage>=Number(f.c.toughness))move(f,'graveyard');}
         c.zone='Graveyard';owner.graveyard.push(c);
       }else if(c.name==='Swords to Plowshares'){
         const f=target(s,a.creatureId,'Creature'),controller=s.players.find(p=>p.id===f.c.controllerId)||f.p;controller.life+=Math.max(0,Number(f.c.power)||0);move(f,'exile');if(f.c.isToken)f.p.exile=f.p.exile.filter(x=>x.id!==f.c.id);c.zone='Graveyard';owner.graveyard.push(c);
       }else fail('尚未实现此结算。');
     }
     events.push({type:'SPELL_RESOLVED',cardName:item.sourceCard.name,cardId:item.sourceCard.id,message:item.abilityDescription});
   }
   if(a.type==='activate_fetch'){
     const f=find(s,a.cardId);if(!f||f.z!=='battlefield'||f.p.id!==p.id||f.c.tapped)fail('找地不在己方战场或已横置。');
     if(!['Flooded Strand','Scalding Tarn','Prismatic Vista'].includes(f.c.name))fail('暂不支持这张找地。');
     if(board(s).some(c=>['Disruptor Flute','Pithing Needle','Petrified Hamlet'].includes(c.name)&&named(c,f.c.name)))fail('命名锁件禁止启动这张找地。');
     if(p.life<1)fail('不能支付 1 点生命。');p.life--;const source=clone(f.c);move(f,'graveyard');push(s,source,p,source.name+'：搜寻地牌并洗牌。',true,{_localEffect:'fetch',_fetchName:source.name});
     events.push({type:'ABILITY_ACTIVATED',cardName:source.name,cardId:source.id,playerIndex:p.id,playerName:p.name,message:p.name+' 启动 '+source.name});
   }
   if(a.type==='resolve_fetch'){
     if(!ctx.assumed)unknown('结算找地异能需要明确假设对手不响应。');
     const item=s.stack[0];if(item?._localEffect!=='fetch')fail('堆叠顶不是本分支创建的找地异能。');
     if(ctx.shuffled)unknown('此段已洗牌，第一版不能再次确认未记录的牌库身份。');
     const known=ctx.knownCards[String(a.landId)];if(!known?.types?.includes('Land')||find(s,known.id))fail('目标地牌不是已知牌库中的可用对象。');
     const c={power:0,toughness:0,damage:0,hasSummoningSickness:false,isToken:false,attachedCards:[],keywords:[],isAttacking:false,isBlocking:false,isTransformed:false,isBackFace:false,isPhasedOut:false,oracleText:(known.abilities||[]).join('\n'),...clone(known)};
     if(['Plains','Island','Swamp','Mountain','Forest'].includes(c.name))c.supertypes=['Basic'];
     const name=item._fetchName,subs=c.subtypes||[];
     if(name==='Flooded Strand'&&!subs.some(x=>['Plains','Island'].includes(x)))fail('Flooded Strand 不能寻找这张地。');
     if(name==='Scalding Tarn'&&!subs.some(x=>['Island','Mountain'].includes(x)))fail('Scalding Tarn 不能寻找这张地。');
     if(name==='Prismatic Vista'&&!c.supertypes?.includes('Basic'))fail('Prismatic Vista 只能寻找基本地。');
     if(!c.supertypes?.includes('Basic')&&!['Plateau','Tundra','Volcanic Island'].includes(c.name))fail('暂不支持目标地的进场效应。');
     if(!p.librarySize)fail('牌库为空。');s.stack.shift();Object.assign(c,{zone:'Battlefield',ownerId:p.id,controllerId:p.id,tapped:false,faceDown:false,counters:{},damage:0});p.battlefield.push(c);p.librarySize--;delete p.libraryTop;ctx.shuffled=true;
     events.push({type:'SHUFFLE',playerName:p.name,playerIndex:p.id,message:p.name+' shuffled their library'});
   }
   s.pendingAction=null;s.priorityPlayerId=p.id;
   return {state:s,context:ctx,events};
 }
 const api={apply,Stop,capabilities:{provider:'local-supported-v1',actions:ACTIONS,cards:SUPPORTED,limits:['不接受任意状态 patch','未知抓牌或未实现规则会停止','结算与推进时机需要列明对手不响应的假设','不是完整万智牌规则引擎']}};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BranchEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this);
