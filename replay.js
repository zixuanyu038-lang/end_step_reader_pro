(function (root) {
  'use strict';
  const PHASES = {UNKNOWN:'准备',UNTAP:'重置步骤',UPKEEP:'维持步骤',DRAW:'抓牌步骤',MAIN1:'战斗前主阶段',PRECOMBAT_MAIN:'战斗前主阶段',BEGIN_COMBAT:'战斗开始步骤',DECLARE_ATTACKERS:'宣告攻击者步骤',DECLARE_BLOCKERS:'宣告阻挡者步骤',FIRST_STRIKE_DAMAGE:'先攻战斗伤害步骤',COMBAT_DAMAGE:'战斗伤害步骤',END_COMBAT:'战斗结束步骤',MAIN2:'战斗后主阶段',POSTCOMBAT_MAIN:'战斗后主阶段',END_STEP:'结束步骤',CLEANUP:'清除步骤',BEGINNING:'开始阶段',COMBAT:'战斗阶段',ENDING:'结束阶段'};
  Object.assign(PHASES,{END_OF_TURN:'结束步骤',COMBAT_BEGIN:'战斗开始步骤',COMBAT_DECLARE_ATTACKERS:'宣告攻击者步骤',COMBAT_DECLARE_BLOCKERS:'宣告阻挡者步骤',COMBAT_END:'战斗结束步骤',COMBAT_FIRST_STRIKE_DAMAGE:'先攻战斗伤害步骤'});
  const ZONES = {Library:'牌库',Hand:'手牌',Battlefield:'战场',Graveyard:'坟墓场',Exile:'放逐区',Stack:'堆叠',Command:'统帅区',Sideboard:'备牌'};
  const KINDS = {SPELL_CAST:'施法',SPELL_RESOLVED:'结算',SPELL_REMOVED_FROM_STACK:'堆叠',ABILITY_ACTIVATED:'起动',TRIGGER_FIRED:'触发',LAND_PLAYED:'下地',CARD_ZONE_CHANGE:'移区',CARD_COUNTERS:'指示物',CARD_REVEALED:'展示／检视',CARD_REVEALED_TO_HAND:'入手',ATTACKERS_DECLARED:'攻击',BLOCKERS_DECLARED:'阻挡',PLAYER_DAMAGED:'伤害',PLAYER_LIFE_CHANGED:'生命',MODE_CHOSEN:'模式',VALUE_CHOSEN:'选择',MULLIGAN:'调度',HAND_KEPT:'留牌',HAND_SETTLED:'起手',TURN_PHASE:'阶段',TURN_BEGAN:'回合',GAME_STARTED:'开局',GAME_OUTCOME:'结果',TOKEN_CREATED:'衍生物',MANA_LOG:'法术力',SHUFFLE:'洗牌',LIBRARY_REARRANGED:'牌库排序',COMBAT_ENDED:'战斗结束',EFFECT_REPLACED:'替代效应',ADD_LOG:'日志',PLAYER_CONTROL:'控制',GAME_FINISHED:'结束'};
  const QUIET = new Set(['TURN_PHASE','TURN_BEGAN','GAME_STARTED','COMBAT_ENDED','SPELL_REMOVED_FROM_STACK','MANA_LOG','ADD_LOG','PLAYER_CONTROL','HAND_KEPT','GAME_FINISHED']);
  const phase = x => PHASES[x] || x || '准备';
  const zone = x => ZONES[x] || x || '未知区域';
  const safe = x => !['__proto__','constructor','prototype'].includes(x);
  function patch(base, p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('无法识别的状态补丁');
    if (Object.hasOwn(p,'s')) return p.s;
    if (Object.hasOwn(p,'a')) {
      if (!Array.isArray(p.a)) throw Error('数组补丁格式不正确');
      const index = new Map((Array.isArray(base)?base:[]).map(v=>[String(v.id),v]));
      return p.a.map(item=>{
        if (Object.hasOwn(item,'v')) return item.v;
        if (!index.has(String(item.id))) throw Error('补丁引用了不存在的对象 '+item.id);
        const old=index.get(String(item.id));
        return item.p ? patch(old,item.p) : old;
      });
    }
    if (!Object.hasOwn(p,'o') && !Object.hasOwn(p,'d')) throw Error('未知补丁指令');
    const result={...(base||{})};
    for (const k of p.d || []) if(safe(k)) delete result[k];
    for (const [k,v] of Object.entries(p.o||{})) if(safe(k)) result[k]=patch(result[k],v);
    return result;
  }
  function cardsIn(state) {
    const all=[];
    for(const p of state?.players||[]) for(const z of ['hand','battlefield','graveyard','exile','command']) all.push(...(p[z]||[]));
    for(const item of state?.stack||[]) if(item.sourceCard) all.push(item.sourceCard);
    return all;
  }
  function cardName(c) { return !c || c.faceDown || c.name==='Hidden card' ? '未知牌' : c.name; }
  function lookup(state,id) {
    const c=cardsIn(state).find(c=>String(c.id)===String(id));
    if(c) return cardName(c);
    const s=(state?.stack||[]).find(s=>String(s.stackTargetId)===String(id));
    return s ? (s.sourceCard ? cardName(s.sourceCard) : '堆叠上的对象') : '未识别对象 #'+id;
  }
  function shortCard(c) {
    return {id:c.id,name:cardName(c),hidden:!!c.faceDown||c.name==='Hidden card',tapped:!!c.tapped,types:c.types||[],subtypes:c.subtypes||[],supertypes:c.supertypes||[],keywords:c.keywords||[],manaCost:c.manaCost||'',chosenMarks:c.chosenMarks||[],power:c.power,toughness:c.toughness,counters:c.counters||{},attacking:!!c.isAttacking,blocking:!!c.isBlocking,transformed:!!c.isTransformed,damage:c.damage||0};
  }
  function snapshot(state,t) {
    return {t,turn:state.turnNumber,phase:phase(state.step && state.step!=='UNKNOWN'?state.step:state.phase),active:state.activePlayerId,players:(state.players||[]).map(p=>({id:p.id,name:p.name,life:p.life,handSize:p.handSize,librarySize:p.librarySize,manaPool:{...(p.manaPool||{})},monarch:!!p.hasMonarch,initiative:!!p.hasInitiative,poison:p.poisonCounters||0,hand:(p.hand||[]).map(shortCard),battlefield:(p.battlefield||[]).map(shortCard),graveyard:(p.graveyard||[]).map(shortCard),exile:(p.exile||[]).map(shortCard)})),stack:(state.stack||[]).map(s=>({name:cardName(s.sourceCard),ability:!!s.isAbility,trigger:!!s.isTrigger,text:s.abilityDescription||'',targets:s.targets||[]}))};
  }
  function modeText(s) {
    return ({'Target player draws two cards.':'目标牌手抓两张牌','Destroy target artifact.':'消灭目标神器','Flame of Anor deals 5 damage to target creature.':'Flame of Anor 对目标生物造成 5 点伤害'})[s]||s;
  }
  function effectText(msg) {
    let m;
    if(m=msg.match(/^(.+?) \(\d+\) - (.+?) searches their library for (a Plains or Island card|an Island or Mountain card|a basic land card), puts it onto the battlefield, then shuffles\./))return `${m[1]} 的异能结算：${m[2]} 从牌库搜寻${{'a Plains or Island card':'一张平原或海岛牌','an Island or Mountain card':'一张海岛或山脉牌','a basic land card':'一张基本地牌'}[m[3]]}，放进战场，然后洗牌。`;
    if(m=msg.match(/^(.+?) \(\d+\) - (.+?) draws three cards, then puts two cards from their hand on top of their library in any order\./))return `${m[1]} 结算：${m[2]} 抓三张牌，然后将两张手牌以任意顺序放回牌库顶。`;
    if(m=msg.match(/^(.+?) \(\d+\) - (.+?) looks at the top three cards of their library\. They put (one|two) of them into their hand and put the rest on the bottom of their library in any order\./))return `${m[1]} 结算：${m[2]} 检视牌库顶三张牌，将其中${m[3]==='one'?'一':'两'}张加入手牌，其余以任意顺序放到牌库底。`;
    if(m=msg.match(/^(.+?) \(\d+\) - (.+?) draws (seven|two|a) cards?\./))return `${m[1]} 结算：${m[2]} 抓${{seven:'七',two:'两',a:'一'}[m[3]]}张牌。`;
    if(m=msg.match(/^(.+?) \(\d+\) - Return (.+?) \(\d+\) to its owner's hand\./))return `${m[1]} 的异能结算：将 ${m[2]} 移回其拥有者手上。`;
    if(m=msg.match(/^(.+?) \(\d+\) - Return (.+?) \(\d+\) from the graveyard to its owner's hand\./))return `${m[1]} 的异能结算：将 ${m[2]} 从坟墓场移回其拥有者手上。`;
    if(/^When you cast this spell, exile up to one target permanent that's one or more colors\./.test(msg))return `施放触发异能结算：记录的效应为放逐至多一个目标有色永久物。`;
    if(/^Whenever you draw your third card in a turn, exile Tamiyo, then return her to the battlefield transformed/.test(msg))return 'Tamiyo, Inquisitive Student 的抓第三张牌触发异能结算：将其放逐，再以转化状态移回战场。';
    if(/^When Court of Grace enters, you become the monarch\./.test(msg))return 'Court of Grace 的进场触发异能结算：其操控者成为君主。';
    if(/^At the beginning of your end step, draw a card\./.test(msg))return '结束步骤的触发异能结算：抓一张牌。';
    if(/^At the beginning of your upkeep, create a 1\/1 white Spirit creature token with flying\. If you're the monarch, create a 4\/4 white Angel creature token with flying instead\./.test(msg))return '维持触发异能结算：产生一个 1/1 白色、具飞行的精怪衍生物；若其操控者是君主，则改为产生一个 4/4 白色、具飞行的天使衍生物。';
    if(/^When Snapcaster Mage enters, target instant or sorcery card in your graveyard gains flashback until end of turn\./.test(msg))return 'Snapcaster Mage 的进场触发异能结算：目标坟墓场中的瞬间或法术牌获得返照异能直到回合结束。';
    if(/^When this creature enters, look at the top four cards of your library\. You may reveal a noncreature, nonland card/.test(msg))return '进场触发异能结算：检视牌库顶四张牌，可展示其中一张非生物、非地牌并加入手牌，其余以随机顺序放到牌库底。';
    if(/^Whenever an artifact you control enters, put a loyalty counter on Tezzeret\./.test(msg))return '神器进场的触发异能结算：在 Tezzeret, Cruel Captain 上放置一个忠诚指示物。';
    if(/^When Glimmerpost enters, you gain 1 life for each Locus on the battlefield\./.test(msg))return 'Glimmerpost 的进场触发异能结算：战场上每有一个处所，其操控者便获得 1 点生命。';
    if(m=msg.match(/^(.+?) \(\d+\) - Search your library for an artifact card with mana value 1 or less, reveal it, put it into your hand, then shuffle\./))return `${m[1]} 的异能结算：从牌库搜寻一张法术力值不大于 1 的神器牌，展示并加入手牌，然后洗牌。`;
    if(m=msg.match(/^(.+?) \(\d+\) - \+2: Until your next turn, whenever a creature an opponent controls attacks you or a planeswalker you control, it gets -1\/-0 until end of turn\./))return `${m[1]} 的 +2 异能结算：直到其操控者下回合，每当对手的生物攻击该牌手或其鹏洛客时，该生物得 -1/-0 直到回合结束。`;
    return null;
  }
  function describe(e,state) {
    const who=e.playerName || (state?.players||[]).find(p=>String(p.id)===String(e.playerIndex??e.zoneOwnerIndex))?.name || '牌手';
    const card=e.cardName && e.cardName!=='Hidden card'?e.cardName:'未知牌';
    const msg=e.message||''; const target=e.targetDescription;
    switch(e.type) {
      case 'GAME_STARTED':return `本局开始，${who} 先手。`;
      case 'GAME_OUTCOME':return `${who} 获胜${e.endReason==='concede'?'（对手认输）':''}。`;
      case 'TURN_BEGAN':return `第 ${e.turnNumber} 个全局回合 · ${who}`;
      case 'TURN_PHASE':return phase(e.phase);
      case 'LAND_PLAYED':return `${who} 下地：${card}。`;
      case 'SPELL_CAST':return `${who} 施放 ${card}${target?'，目标：'+target:''}。`;
      case 'ABILITY_ACTIVATED':return `${who} 起动 ${card} 的异能。`;
      case 'TRIGGER_FIRED':return `${who} 的 ${card} 触发异能。`;
      case 'SPELL_RESOLVED': {
        const explicit=msg.match(/^(.+?) \(\d+\) - Counter (.+?) \(\d+\)\./);
        if(explicit) return `${explicit[1]} 结算：反击 ${explicit[2]}。`;
        const counterTarget=msg.match(/Counter target noncreature spell\..*\(Targeting: (.*?)\)/);
        if(counterTarget) return `${card} 结算：尝试反击 ${counterTarget[1]}；若以此法被反击，则以放逐代替置入坟墓场。`;
        if(e.cardName==='Flame of Anor' && /Targeting:/.test(msg)) {
          const parts=[];
          for(const m of msg.matchAll(/Target player draws two cards\. \(Targeting: (.*?)\)/g))parts.push(`${m[1]} 抓两张牌`);
          for(const m of msg.matchAll(/Destroy target artifact\. \(Targeting: (.*?)\)/g))parts.push(`消灭 ${m[1]}`);
          if(parts.length && !/deals \d+ damage/.test(msg))return `${card} 结算（记录的效应）：${parts.join('；')}。`;
        }
        const translated=effectText(msg);
        if(translated)return translated+'\n记录原文：'+msg;
        const x=msg.match(/\(X=(\d+)\)/);
        const trigger=/^(When |Whenever |At the beginning )/.test(msg);
        return `${card==='未知牌'?'堆叠对象':card}${trigger?' 的触发异能':''}结算${x?'（X = '+x[1]+'）':''}。${msg && msg!==e.cardName?'\n记录原文：'+msg:''}`;
      }
      case 'SPELL_REMOVED_FROM_STACK':return `对象离开堆叠。${msg ? '\n记录原文：'+msg : ''}`;
      case 'CARD_ZONE_CHANGE':return `${who} 的 ${card}：${zone(e.fromZone)} → ${zone(e.toZone)}。`;
      case 'CARD_REVEALED_TO_HAND':return `${who} 将 ${card} 加入手牌。`;
      case 'CARD_REVEALED':return `${who} ${e.ownerEcho?'选择了':'检视／展示了'}：${(e.cardNames||[card]).join('、')}。`;
      case 'PLAYER_LIFE_CHANGED':return `${who} 的生命：${e.oldValue} → ${e.newValue}。`;
      case 'PLAYER_DAMAGED':return `${card} 对 ${who} 造成 ${e.amount} 点${/non-combat/i.test(msg)?'非战斗':/combat/i.test(msg)?'战斗':''}伤害。`;
      case 'ATTACKERS_DECLARED':return e.amount===0?`${who} 未宣告攻击。`:`${who} 宣告 ${e.amount??(e.attackerIds||[]).length} 个攻击者${e.attackerIds?.length?'：'+e.attackerIds.map(id=>lookup(state,id)).join('、'):''}。`;
      case 'BLOCKERS_DECLARED':return e.amount===0?`${who} 未宣告阻挡。`:`${who} 宣告 ${e.amount??'若干'} 个阻挡者。${msg?'\n记录原文：'+msg:''}`;
      case 'MULLIGAN':return e.amount!=null?`${who} 调度至 ${e.amount} 张。`:`${who} 选择调度。`;
      case 'HAND_KEPT':return `${who} 选择保留 ${e.amount} 张。`;
      case 'HAND_SETTLED':return `${who} 最终保留 ${e.amount} 张起手${e.mulligans?'（调度 '+e.mulligans+' 次）':''}。`;
      case 'MODE_CHOSEN': {
        const m=msg.match(/^.*? has chosen (.*?) for (.*?)\.$/);
        return m?`${who} 为 ${m[2]} 选择模式：${modeText(m[1])}。`:`${who} 选择模式。\n记录原文：${msg}`;
      }
      case 'VALUE_CHOSEN':return `${who} 为 ${card} 选择：${target==='not to shuffle'?'不洗牌':target||msg}。`;
      case 'CARD_COUNTERS':return `${card} 的指示物：${e.oldValue} → ${e.newValue}。\n记录原文：${msg}`;
      case 'SHUFFLE':return (msg.replace(' shuffled their library','')||who)+' 洗牌。';
      case 'LIBRARY_REARRANGED':return `${who} 调整牌库中的牌序。`;
      case 'TOKEN_CREATED':return `产生衍生物。${msg!=='Token created'?'\n记录原文：'+msg:''}`;
      case 'COMBAT_ENDED':return '战斗结束。';
      case 'MANA_LOG':return `使用法术力异能。\n记录原文：${msg}`;
      case 'EFFECT_REPLACED':return `替代效应记录：${msg}`;
      default:return msg||`记录了 ${e.type||'未知事件'}。`;
    }
  }
  function parse(text,filename='回放') {
    if(typeof text!=='string'||text.length>128*1024*1024)throw Error('解压后文件过大（上限 128 MB）');
    const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);let header=null,state=null,current=null,game=1,step='准备',stateIndex=-1;
    const model={version:1,filename,sourceText:text,header:null,turns:[],states:[],cards:{},warnings:[],eventCount:0,actionCount:0,duration:0,finalScore:[]};
    let personal={},between=false,broken=false;
    const newTurn=(turn=0,player='',personalTurn=0,t=0)=>{const v={id:model.turns.length,game,number:turn,player,personal:personalTurn,t,end:t,entries:[],stateIndex:-1};model.turns.push(v);return v;};
    const remember=()=>{
      if(!state)return;
      for(const c of cardsIn(state))if(cardName(c)!=='未知牌' && !model.cards[c.name]?.oracleText)model.cards[c.name]={name:c.name,types:c.types||[],subtypes:c.subtypes||[],supertypes:c.supertypes||[],power:c.power,toughness:c.toughness,manaCost:c.manaCost||'',oracleText:c.oracleText||'',keywords:c.keywords||[]};
      model.states.push(snapshot(state,model.duration));stateIndex=model.states.length-1;
      if(current&&!between)current.stateIndex=stateIndex;
      if(state.matchScore?.winsBySeat)model.finalScore=state.matchScore.winsBySeat;
    };
    for(let lineNo=0;lineNo<lines.length;lineNo++) {
      if(!lines[lineNo].trim())continue;
      let r;try{r=JSON.parse(lines[lineNo]);}catch{throw Error(`第 ${lineNo+1} 行不是有效 JSON，文件可能不完整。`);}
      if(!header){header=r;if(r.format!=='endstep-replay')throw Error('这不是 Endstep 回放文件（缺少 endstep-replay 标记）。');if(r.formatVersion!==1)model.warnings.push(`文件版本 ${r.formatVersion} 尚未验证，请核对原始记录。`);model.header=r;continue;}
      model.duration=Math.max(model.duration,Number(r.t)||0);
      if(r.k==='key') {state=r.state;broken=false;remember();continue;}
      if(r.k==='diff') {
        if(!broken)try{state=patch(state,r.patch);remember();}catch(err){broken=true;model.warnings.push(`第 ${lineNo+1} 行状态恢复失败：${err.message}。到下个完整快照前，局面不可用。`);stateIndex=-1;}
        continue;
      }
      if(r.k==='chapter') {
        if(r.edge==='start'){game=r.game;personal={};between=false;current=newTurn(0,'',0,r.t);step='准备';if(state?.matchScore?.gameNumber===game)current.stateIndex=stateIndex;}
        else if(r.edge==='end'){if(current){current.end=r.t;current.outcome=r.outcome;}between=true;}
        continue;
      }
      if(r.k==='action'){
        model.actionCount++;
        if(r.action?.type==='PASS_PRIORITY'&&current&&!between&&stateIndex>=0)
          current.entries.push({sourceLine:lineNo+1,t:r.t||0,type:'PASS_PRIORITY',kind:'优先权',
            phase:phase(state?.step||state?.phase),text:'让过优先权',quiet:true,stateIndex,raw:r.action,rawRecord:lines[lineNo]});
        continue;
      }
      if(r.k==='priority-phase'||r.k==='priority-window'){
        const turn=model.turns.findLast(turn=>turn.game===r.game&&Number(turn.number)===r.turn);
        if(turn){
          const stateIndex=r.state?model.states.push(r.state)-1:turn.stateIndex;
          turn.entries.push({sourceLine:lineNo+1,t:r.t||0,type:'RECOVERED_PRIORITY',kind:'补全',phase:phase(r.phase),
            text:r.k==='priority-phase'?'补全阶段':'补全优先权 · 玩家 '+r.priorityPlayerId,quiet:false,stateIndex,raw:r,rawRecord:lines[lineNo]});
        }
        continue;
      }
      if(r.k!=='event'){model.warnings.push(`第 ${lineNo+1} 行记录类型 ${r.k} 未识别，未解释。`);continue;}
      const e=r.event;if(!e||typeof e!=='object')throw Error(`第 ${lineNo+1} 行缺少事件对象。`);
      model.eventCount++;
      if(e.type==='TURN_BEGAN') {
        if(current)current.end=r.t;
        const key=String(e.playerIndex);personal[key]=(personal[key]||0)+1;
        current=newTurn(e.turnNumber,e.playerName||key,personal[key],r.t);current.stateIndex=stateIndex;step='准备';
      }
      if(!current)current=newTurn(0,'',0,r.t);
      if(e.type==='TURN_PHASE')step=phase(e.phase);
      const diagnosticMove=e.type==='CARD_ZONE_CHANGE'&&(e.toZone==='Stack'||e.fromZone==='Stack'||(!current.number&&e.toZone==='Hand'));
      const quiet=(QUIET.has(e.type)&&!(e.type==='ADD_LOG'&&e.message?.startsWith('[CODEX')))||diagnosticMove||(e.type==='ATTACKERS_DECLARED'&&e.amount===0)||(e.type==='BLOCKERS_DECLARED'&&e.amount===0)||(e.type==='MULLIGAN'&&e.amount==null);
      // Keep the exact wire line too: sequence numbers can exceed JavaScript's safe integer range.
      const entry={sourceLine:lineNo+1,t:r.t||0,type:e.type,kind:KINDS[e.type]||'其他',phase:step,text:describe(e,broken?null:state),quiet,stateIndex,raw:e,rawRecord:lines[lineNo]};
      current.entries.push(entry);current.end=r.t||current.end;
      if(e.type==='GAME_OUTCOME'){current.winner=e.playerName;current.endReason=e.endReason;}
    }
    if(!header)throw Error('文件为空。');
    if(!model.eventCount)model.warnings.push('文件没有可读的对局事件。');
    if(header.branchMeta)model.warnings.push(header.branchMeta.engine?'Forge 假设分支：'+(header.branchMeta.complete?'本局完整后续':'未完搜索片段')+'；'+header.branchMeta.title:'Codex 推荐打法示意分支：'+(header.branchMeta.stop?.detail||header.branchMeta.title||''));
    else if(!header.complete)model.warnings.push('此回放标记为未完成，可能缺少后续对局或最终结果。');
    model.warnings=[...new Set(model.warnings)];return model;
  }
  function clock(t){const s=Math.floor((t||0)/1000);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
  function title(turn){return turn.number?`${turn.player} · 自己的第 ${turn.personal} 回合（全局 T${turn.number}）`:'开局与调度';}
  function visible(e,detail=false){return detail||!e.quiet;}
  function markdown(model,detail=false) {
    const h=model.header;const out=['# Endstep 对局档案','',`${h.players.map(p=>p.name).join(' vs ')} · ${h.formatId||'未知赛制'} · 比分 ${model.finalScore.join(' : ')||'未知'}`,'',`录制视角：${h.players.find(p=>p.seat===h.seat)?.name||h.seat}；回放时长 ${clock(model.duration)}。`,'','按文件顺序整理；全局回合编号包含双方回合。隐藏牌保持未知。区域移动不自动解释为抓牌、消灭或牺牲；离开堆叠不自动解释为被反击。未识别的效应保留英文原文。玩家提交的操作不作为已执行事件。',''];
    for(const w of model.warnings)out.push('> '+w,'');
    let game=0;
    for(const turn of model.turns){if(turn.game!==game){game=turn.game;out.push(`## 第 ${game} 局`,'');}out.push(`### ${title(turn)}`,'');let step='';
      for(const e of turn.entries.filter(e=>visible(e,detail))){if(e.phase!==step){step=e.phase;out.push('',`**${step}**`,'');}out.push(`- [${clock(e.t)}] ${e.text.replace(/\n/g,' ')} `);}
      const state=model.states[turn.stateIndex];
      if(state){out.push('','回合末最近记录快照（'+clock(state.t)+'）：');for(const p of state.players)out.push(`- ${p.name}：${p.life} 生命；${p.handSize} 张手牌；战场：${p.battlefield.map(c=>c.name+(c.tapped?'〔横置〕':'')).join('、')||'空'}。`,`- 手牌：${p.hand.map(c=>c.name).join('、')||'无'}。`);}
      out.push('');
    }
    out.push('## 规则说明','','术语参考：https://magic.wizards.com/en/rules 。规则 121.1、113.7a、701.6；本工具整理记录，不模拟规则或判定最优操作。');return out.join('\n');
  }
  const api={parse,patch,describe,phase,zone,clock,title,visible,markdown,cardName,snapshot};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Replay=api;
})(typeof globalThis!=='undefined'?globalThis:this);
