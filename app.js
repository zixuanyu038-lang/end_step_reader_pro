'use strict';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let model=null,selected=0,game=1,detailed=false,query='',focused=-1,dragCount=0,toastTimer,rawLines=[],view='report',branchChoices=[],branchAnchor=null,branchSnapshot=null,branchResult=null,branchRevision=0,branchError=null;
function notify(text,error=false){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?9500:3200);}
function gameTurns(){return model.turns.filter(t=>t.game===game);}
function isShown(e){return Replay.visible(e,detailed)&&(!query||`${e.text} ${e.raw.message||''} ${e.kind}`.toLowerCase().includes(query));}
function loadModel(next){
  if(!next||next.version!==1||!Array.isArray(next.turns)||!Array.isArray(next.states)||!next.header?.players)throw Error('战报数据格式不兼容。');
  model=next;game=model.turns[0]?.game||1;selected=model.turns[0]?.id??0;focused=-1;query='';$('search').value='';rawLines=[];$('raw-search').value='';$('raw-kind').value='';$('raw-text').value='';
  $('landing').hidden=true;$('workspace').hidden=false;document.body.classList.add('has-replay');
  branchChoices=[];branchAnchor=null;branchSnapshot=null;branchResult=null;branchError=null;branchRevision++;$('branch-repair').hidden=true;$('branch-input').value='';$('branch-status').textContent='等待导入推荐打法。';$('branch-preview').innerHTML='<p class="step-description">检查后会在这里列出推荐步骤与停止原因。</p>';$('branch-export').disabled=true;$('branch-local-preview').disabled=true;
  prepareBranch();
  const h=model.header;const players=h.players||[];
  $('match-title').innerHTML=players.map(p=>esc(p.name)).join('<span class="versus">vs.</span>');
  const recorded=new Date(h.recordedAt);const date=Number.isNaN(recorded.getTime())?'时间未记录':recorded.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
  $('match-meta').textContent=`${h.formatId||'UNKNOWN'} / ${date}`;
  $('match-sub').textContent=`录制视角 ${players.find(p=>p.seat===h.seat)?.name??'未知'}  ·  ${Replay.clock(model.duration)}  ·  ${model.eventCount} 条事件${h.complete?'':'  ·  未完成'}`;
  $('score').innerHTML=h.branchMeta?'—':model.finalScore.length?model.finalScore.map(esc).join('<span class="score-colon">:</span>'):'—';
  document.querySelector('.score-caption').textContent=h.branchMeta?'假设分支':'局分';
  const notices=[...model.warnings];if(h.branchMeta?.assumptions?.length)notices.push('推演含假设（适用于分歧点之后）：'+h.branchMeta.assumptions.map(a=>typeof a==='string'?a:a.basis).join('；'));$('warnings').textContent=notices.join('\n');$('warnings').hidden=!notices.length;
  renderGames();render();switchView('report');document.title=`${players.map(p=>p.name).join(' vs ')} · Endstep 对局档案`;
  globalThis.Studio?.onModel(model);
}
function switchView(next){
  view=next;const raw=next==='jsonl',codex=next==='codex';
  $('report-view').hidden=next!=='report';$('report-toolbar').hidden=next!=='report';$('jsonl-view').hidden=!raw;$('codex-view').hidden=!codex;
  for(const [id,active] of [['view-report',next==='report'],['view-jsonl',raw],['view-codex',codex]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
  if(raw)renderRaw();if(codex)prepareBranch();
}
function prepareBranch(){
  $('handoff-prompt').value=Branch.prompt();
  if(!model?.sourceText){updateBranchSelection();return;}
  try{
    if(!branchChoices.length)branchChoices=Branch.decisions(model.sourceText);
  }catch(error){notify('分歧点读取失败：'+error.message,true);}
  updateBranchSelection();
}
function updateBranchSelection(){
  const choice=branchChoices.find(d=>d.line===branchAnchor);
  const description=choice?`第 ${choice.game} 局 · T${choice.turn} · ${Replay.clock(choice.t)}\n${choice.label}之前`:'尚未选择分支起点';
  $('branch-selection').textContent=description;$('rail-branch-selection').textContent=description;
  $('handoff-download').disabled=!choice;$('rail-branch-continue').disabled=!choice;
  $('branch-locate').textContent=choice?'在回合索引中查看 ↗':'去回合索引选择 ↗';
}
function renderBranchChoices(){
  const turn=model.turns[selected],choices=branchChoices.filter(d=>d.game===turn.game&&d.turn===Number(turn.number));
  $('turn-branch-options').innerHTML=choices.length?choices.map(d=>`<button class="branch-choice ${d.line===branchAnchor?'active':''}" data-branch-line="${d.line}" aria-pressed="${d.line===branchAnchor}"><time>${Replay.clock(d.t)}</time><span>${esc(d.label)}<small>${d.line===branchAnchor?'已选为起点':'从此操作前分支'}</small></span></button>`).join(''):'<p class="branch-empty">此回合没有可用的出牌分歧点。</p>';
  updateBranchSelection();
}
function chooseBranch(line){
  const choice=branchChoices.find(d=>d.line===line);if(!choice)return;
  try{
    const b=Branch.baseline(model.sourceText,line);
    const turn=model.turns.find(t=>t.game===choice.game&&Number(t.number)===choice.turn);if(!turn)return;
    branchAnchor=line;game=turn.game;selected=turn.id;focused=-1;
    const last=b.rows.filter(x=>x.line<line&&['key','diff'].includes(x.row.k)).at(-1);
    branchSnapshot={turnId:turn.id,state:Replay.snapshot(b.state,last?.row.t??choice.t)};
    renderGames();render();
    revealSelectedTurn();
    $('turn-branch-options').querySelector(`[data-branch-line="${line}"]`)?.focus({preventScroll:true});
  }catch(error){notify('无法选择分支起点：'+error.message,true);}
}
function locateBranch(){
  if(branchAnchor)chooseBranch(branchAnchor);
  switchView('report');
  revealSelectedTurn();
  const target=$('turn-branch-options').querySelector(`[data-branch-line="${branchAnchor}"]`)||$('turn-branch-options').querySelector('button')||$('turn-branch-heading');
  target.scrollIntoView({block:'nearest'});target.focus({preventScroll:true});
}
function saveNamed(content,type,name){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function exportHandoff(){
  try{if(branchAnchor==null)throw Error('请先在回合索引中选择一个分支起点。');const data=await Branch.handoff(model,branchAnchor,$('branch-focus').value);saveNamed(JSON.stringify(data,null,2),'application/json;charset=utf-8','codex-handoff.json');notify('交接文件已下载。把文件和提示词一起交给 Codex。');}catch(error){notify(error.message,true);}
}
function invalidateBranch(){branchRevision++;branchResult=null;branchError=null;$('branch-repair').hidden=true;$('branch-export').disabled=true;$('branch-local-preview').disabled=true;$('branch-status').textContent='内容已改变，请重新检查。';}
async function checkBranch(){
  invalidateBranch();const source=model,revision=branchRevision;
  try{
    const result=await Branch.compile(source.sourceText,$('branch-input').value);
    if(model!==source||revision!==branchRevision)return;
    branchResult=result;$('branch-export').disabled=false;$('branch-local-preview').disabled=false;
    $('branch-status').textContent=`动作执行通过 · ${result.stepCount} 步 · ${result.data.assumptions.length?'含明确假设':'无额外假设'}。${result.stopped?'已在未知或未支持的步骤前停止。':'请核对规则覆盖范围。'}`;
    $('branch-preview').innerHTML=`<h4>${esc(result.data.title)}</h4><p>${esc(result.data.summary)}</p>${result.data.assumptions.length?'<div class="assumptions">假设：'+result.data.assumptions.map(esc).join('<br>')+'</div>':''}<ol>${result.frames.map(f=>`<li><b>${esc(f.label)}</b><p>${esc(f.explanation)}</p></li>`).join('')}</ol><div class="branch-stop">停止：${esc(result.data.stop.detail)}</div>`;
  }catch(error){if(model!==source||revision!==branchRevision)return;branchError={code:error.code||'invalid_plan',path:error.path||'',step:error.step||null,message:error.message};$('branch-status').textContent='检查未通过：'+(error.path?error.path+' · ':'')+error.message;$('branch-repair').hidden=false;notify(error.message,true);}
}
async function readBranchFile(file){if(!file)return;if(!model?.sourceText){notify('请先导入原回放，再导入 Codex 的分支 JSON。',true);return;}if(file.size>12*1024*1024){notify('分支 JSON 超过 12 MB，请缩短路线。',true);return;}$('branch-input').value=await file.text();switchView('codex');await checkBranch();}
async function exportBranch(){
  if(!branchResult)return;
  try{
    if(typeof CompressionStream==='undefined')throw Error('当前浏览器不支持生成 Gzip，请升级浏览器。');
    const result=branchResult;const compressed=await new Response(new Blob([result.jsonl]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    if(compressed.size>16*1024*1024)throw Error('文件超过 Endstep 已验证的 16 MB 压缩上限。');
    saveNamed(compressed,'application/gzip',(model.filename||'endstep').replace(/\.(esreplay|jsonl|ndjson)$/i,'')+'-codex-branch.esreplay');notify('分支回放已生成。在 Endstep 本地回放入口选择该文件。');
  }catch(error){notify('生成失败：'+error.message,true);}
}
function renderRaw(){
  if(!model)return;
  if(!model.sourceText){$('raw-text').value='这份旧版战报没有内嵌原始 JSONL，请重新导入 .esreplay 文件。';$('save-jsonl').disabled=true;return;}
  $('save-jsonl').disabled=false;
  if(!rawLines.length)rawLines=model.sourceText.replace(/^\uFEFF/,'').split(/\r?\n/).filter(s=>s.trim()).map(line=>{let k='';try{k=JSON.parse(line).k||'header';}catch{k='unknown';}return {line,k};});
  const kind=$('raw-kind').value,q=$('raw-search').value.toLowerCase();
  const rows=rawLines.filter(r=>(!kind||r.k===kind)&&(!q||r.line.toLowerCase().includes(q)));
  $('raw-text').value=!kind&&!q?model.sourceText:rows.map(r=>r.line).join('\n');
  $('raw-count').textContent=`${rows.length.toLocaleString()} / ${rawLines.length.toLocaleString()} 行`;
}
async function openFile(file){
  if(!file)return;
  if(file.size>40*1024*1024){notify('文件超过 40 MB，请使用较小的单场回放。',true);return;}
  document.body.classList.add('busy');notify('正在恢复回合与局面…');
  try{
    await new Promise(r=>setTimeout(r,30));
    const signature=new Uint8Array(await file.slice(0,2).arrayBuffer());let text;
    if(signature[0]===0x1f&&signature[1]===0x8b){
      if(typeof DecompressionStream==='undefined')throw Error('当前浏览器不支持 Gzip 解压，请使用较新版 Edge、Chrome 或 Firefox。');
      const reader=file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const chunks=[];let length=0;
      while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>128*1024*1024){await reader.cancel();throw Error('解压后文件超过 128 MB。');}chunks.push(value);}
      text=await new Blob(chunks).text();
    }else text=await file.text();
    loadModel(Replay.parse(text,file.name));notify(`已整理 ${new Set(model.turns.map(t=>t.game)).size} 局对局，${model.eventCount} 条事件。`);
  }catch(error){notify(`无法读取：${error.message||'文件损坏或格式不支持'}`,true);}
  finally{document.body.classList.remove('busy');$('file').value='';}
}
function renderGames(){
  $('games').innerHTML=[...new Set(model.turns.map(t=>t.game))].map(n=>{
    const result=model.turns.filter(t=>t.game===n).find(t=>t.winner);
    const mine=model.header.players.find(p=>p.seat===model.header.seat)?.name;
    return `<button class="game-tab ${n===game?'active':''}" data-game="${n}" aria-pressed="${n===game}">第 ${String(n).padStart(2,'0')} 局 <span>${result?(result.winner===mine?'胜':'负'):'进行中'}</span></button>`;
  }).join('');
}
function render(){if(!model)return;renderTurns();renderBranchChoices();renderReading();renderBoard();}
function renderTurns(){
  const turns=gameTurns();$('turn-count').textContent=`${turns.filter(t=>t.number).length} TURNS`;
  const anchor=branchChoices.find(d=>d.line===branchAnchor);
  $('turns').innerHTML=turns.map(t=>`<button class="turn-button ${t.id===selected?'active':''} ${query&&t.entries.some(isShown)?'matching':''}" data-turn="${t.id}" ${t.id===selected?'aria-current="true"':''}><span class="turn-n">${t.number?String(t.personal).padStart(2,'0'):'—'}</span><span class="turn-person">${esc(t.number?t.player:'开局与调度')}<small>${t.number?`T${t.number} · `:''}${Replay.clock(t.t)}${anchor&&t.game===anchor.game&&Number(t.number)===anchor.turn?' · 分支起点':''}</small></span></button>`).join('');
}
function renderReading(){
  const turn=model.turns[selected];if(!turn)return;
  $('turn-kicker').textContent=`GAME ${String(game).padStart(2,'0')} / ${turn.number?'GLOBAL TURN '+String(turn.number).padStart(2,'0'):'OPENING HAND'} / ${Replay.clock(turn.t)}`;
  $('turn-title').textContent=turn.number?`${turn.player} 的第 ${turn.personal} 回合`:'开局与调度';
  const ids=gameTurns().map(t=>t.id),pos=ids.indexOf(selected);$('prev').disabled=pos<=0;$('next').disabled=pos>=ids.length-1;
  $('search-note').hidden=!query;
  const matches=model.turns.filter(t=>t.game===game).reduce((n,t)=>n+t.entries.filter(isShown).length,0);
  $('search-note').textContent=query?`本局找到 ${matches} 条匹配记录。左侧标点的回合包含结果。`:'';
  let last='',html='',count=0;
  turn.entries.forEach((e,i)=>{
    if(!isShown(e))return;count++;
    if(e.phase!==last){last=e.phase;html+=`<div class="phase-label">${esc(last)}</div>`;}
    const parts=e.text.split('\n记录原文：');
    const branchable=e.sourceLine&&['SPELL_CAST','ABILITY_ACTIVATED','LAND_PLAYED','MODE_CHOSEN','ATTACKERS_DECLARED','BLOCKERS_DECLARED','TRIGGER_FIRED'].includes(e.type);
    html+=`<div class="event-row"><button class="event ${i===focused?'selected':''}" data-entry="${i}" data-type="${esc(e.type)}" aria-label="${esc(parts[0])}，查看此前快照"><time>${Replay.clock(e.t)}</time><div><span class="event-kind">${esc(e.kind)}</span><div class="event-text">${esc(parts[0])}</div>${parts[1]?`<div class="event-raw-text">${esc(parts[1])}</div>`:''}</div></button>${branchable?`<button class="event-branch-button" data-ai-branch="${e.sourceLine}" aria-label="从${esc(parts[0])}之前开分支">从这里开分支 ↗</button>`:''}</div>`;
    if(i===focused)html+=`<details class="raw-inspector"><summary>查看这条事件的原始记录</summary><pre>${esc(e.rawRecord||JSON.stringify(e.raw,null,2))}</pre></details>`;
  });
  if(!count)html=`<p class="empty">${query?'本回合没有匹配记录。可选择左侧标点的回合，或清空搜索。':'本回合没有精简事件。切换「完整记录」可查看阶段与底层日志。'}</p>`;
  $('events').innerHTML=html;
}
function cardRows(cards){
  const groups=[];const keys=new Map();
  for(const c of cards){const flags=[c.tapped?'横置':'',c.attacking?'攻击':'',c.blocking?'阻挡':'',c.transformed?'已转化':'',...Object.entries(c.counters||{}).filter(([,v])=>v).map(([k,v])=>`${k} ${v}`),c.damage?`伤害 ${c.damage}`:''].filter(Boolean).join(' · ');
    const pt=c.types?.includes('Creature')?`${c.power}/${c.toughness}`:'';const key=[c.name,flags,pt].join('|');
    if(keys.has(key))groups[keys.get(key)].count++;else{keys.set(key,groups.length);groups.push({c,flags,pt,count:1});}
  }
  return groups.map(({c,flags,pt,count})=>`<div class="card-row ${c.tapped?'tapped':''}"><span class="card-qty">${count>1?count+'×':'·'}</span>${c.hidden?'<span>未知牌</span>':`<button data-card="${esc(c.name)}">${esc(c.name)}</button>`}<span class="card-flags">${esc([pt,flags].filter(Boolean).join(' · '))}</span></div>`).join('');
}
function renderBoard(){
  const turn=model.turns[selected],entry=focused>=0?turn.entries[focused]:null;
  const branchState=!entry&&branchSnapshot?.turnId===turn.id?branchSnapshot.state:null;
  const state=branchState||model.states[entry?entry.stateIndex:turn.stateIndex];
  $('reset-state').hidden=!entry&&!branchState;
  if(!state){$('snapshot-caption').textContent='此处没有可恢复的局面快照。';$('board-state').innerHTML='<p class="empty">请参考事件记录。</p>';return;}
  $('snapshot-caption').textContent=`${branchState?'分支操作前最近快照':entry?'事件前最近快照':'回合末最近快照'} · ${Replay.clock(state.t)}\n${state.phase} · 点击事件可切换观察时点`;
  let html='';
  if(state.stack.length)html+=`<div class="stack-note"><div class="zone-heading">快照中的堆叠 · 文件顺序</div>${state.stack.map(s=>`<div>${esc(s.name)}${s.ability?'〔'+(s.trigger?'触发':'起动')+'异能〕':''}</div>`).join('')}</div>`;
  for(const p of state.players){
    const unknown=p.hand.filter(c=>c.hidden).length;const hand=p.hand.filter(c=>!c.hidden);
    html+=`<section class="player-block"><div class="player-head"><b>${esc(p.name)}</b><span class="life">${esc(p.life)}<small>LIFE</small></span></div><div class="player-meta">手牌 ${esc(p.handSize)} · 牌库 ${esc(p.librarySize)}${p.monarch?' · 君主':''}${p.initiative?' · 先制':''}${p.poison?' · 中毒 '+p.poison:''}</div><div class="zone-heading"><span>战场</span><span>${p.battlefield.length}</span></div>${cardRows(p.battlefield)||'<div class="unknown-hand">空战场</div>'}<div class="zone-heading"><span>手牌</span><span>${esc(p.handSize)}</span></div>${cardRows(hand)}${unknown?`<div class="unknown-hand">${unknown} 张未知牌 · 对录制视角隐藏</div>`:''}${!p.hand.length?'<div class="unknown-hand">无已记录手牌</div>':''}`;
    for(const [z,label] of [['graveyard','坟墓场'],['exile','放逐区']])html+=`<details class="zone-details"><summary>${label} · ${p[z].length}</summary>${cardRows(p[z])||'<p class="unknown-hand">空</p>'}</details>`;
    html+='</section>';
  }
  $('board-state').innerHTML=html;
}
function revealSelectedTurn(){$('turns').querySelector(`[data-turn="${selected}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});}
function chooseTurn(id){selected=id;focused=-1;branchSnapshot=null;render();revealSelectedTurn();}
function moveTurn(offset){const turns=gameTurns(),pos=turns.findIndex(t=>t.id===selected),next=turns[pos+offset];if(next)chooseTurn(next.id);}
function download(content,type,extension){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=(model.filename||'endstep').replace(/\.(esreplay|jsonl|ndjson)$/i,'')+(extension==='jsonl'?'-原始.':'-战报.')+extension;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function exportFile(kind){
  if(!model)return;
  try{
    if(kind==='jsonl'){
      if(!model.sourceText)throw Error('这份旧版战报未包含原始 JSONL，请重新导入原文件。');
      download(model.sourceText,'application/x-ndjson;charset=utf-8','jsonl');
    }
    else if(kind==='json')download(JSON.stringify(model,null,2),'application/json;charset=utf-8','json');
    else if(kind==='html'){
      // Export from the pristine shell, with serialized data escaped out of HTML's script context.
      const template=document.documentElement.cloneNode(true);
      template.querySelector('#workspace').hidden=true;template.querySelector('#landing').hidden=false;
      for(const id of ['events','turns','games','board-state','warnings'])template.querySelector('#'+id).innerHTML='';
      for(const dialog of template.querySelectorAll('dialog'))dialog.removeAttribute('open');
      template.querySelector('#toast').hidden=true;template.querySelector('#drop').hidden=true;
      template.querySelector('#search').value='';template.querySelector('#export-menu').hidden=true;
      template.querySelector('#raw-text').value='';template.querySelector('#raw-text').textContent='';
      template.querySelector('#branch-input').value='';template.querySelector('#branch-input').textContent='';
      template.querySelector('#branch-preview').innerHTML='';
      template.querySelector('#export').setAttribute('aria-expanded','false');
      template.querySelector('body').classList.remove('busy');
      template.querySelector('#embedded-replay')?.remove();
      const data=document.createElement('script');data.id='embedded-replay';data.type='application/json';data.textContent=JSON.stringify(model).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
      template.querySelector('body').prepend(data);
      // The distributable has all assets inline. Source development files are inlined when exporting too.
      for(const script of [...template.querySelectorAll('script[src]')]){const text=await fetch(script.getAttribute('src')).then(r=>{if(!r.ok)throw Error('导出资源读取失败');return r.text();});script.removeAttribute('src');script.textContent=text;}
      for(const link of [...template.querySelectorAll('link[rel="stylesheet"]')]){const style=document.createElement('style');style.textContent=await fetch(link.getAttribute('href')).then(r=>r.text());link.replaceWith(style);}
      download('<!doctype html>\n'+template.outerHTML,'text/html;charset=utf-8','html');
    }else download(Replay.markdown(model,detailed),'text/plain;charset=utf-8',kind);
    notify('战报已导出。');
  }catch(error){notify('导出失败：'+error.message,true);}
  $('export-menu').hidden=true;$('export').setAttribute('aria-expanded','false');
}
function showCard(name){
  const c=model.cards[name];if(!c)return;
  $('card-title').textContent=c.name;$('card-meta').textContent=[c.manaCost,(c.types||[]).join(' / ')].filter(Boolean).join(' · ');
  $('card-oracle').textContent=c.oracleText||'此回放中未记录此牌的牌面文字。';$('card-dialog').showModal();
}
$('open').onclick=$('landing-open').onclick=()=>$('file').click();
$('view-report').onclick=()=>switchView('report');$('view-jsonl').onclick=()=>switchView('jsonl');
$('view-codex').onclick=()=>switchView('codex');$('handoff-download').onclick=exportHandoff;
$('turn-branch-options').onclick=e=>{const b=e.target.closest('[data-branch-line]');if(b)chooseBranch(Number(b.dataset.branchLine));};
$('rail-branch-continue').onclick=()=>switchView('codex');$('branch-locate').onclick=locateBranch;
$('branch-open').onclick=()=>$('branch-file').click();$('branch-file').onchange=e=>readBranchFile(e.target.files[0]).catch(error=>notify(error.message,true));
$('branch-input').oninput=invalidateBranch;$('branch-check').onclick=checkBranch;$('branch-export').onclick=exportBranch;
$('branch-repair').onclick=async()=>{if(!branchError)return;const text='请根据以下执行器错误修正 branch.json，继续使用原 codex-handoff.json。不能改用状态 patch 或编造新动作；缺少规则处理器时缩短路线并说明。返回完整修正后的 JSON。\n\n'+JSON.stringify({error:branchError,submittedPlan:$('branch-input').value},null,2);try{await navigator.clipboard.writeText(text);notify('修正请求已复制，可交给 Codex。');}catch{saveNamed(text,'text/plain;charset=utf-8','codex-branch-error.txt');notify('修正请求已保存为文本文件。');}};
$('branch-local-preview').onclick=()=>{if(branchResult){const jsonl=branchResult.jsonl;loadModel(Replay.parse(jsonl,'codex-branch.esreplay'));const turn=model.turns.find(t=>t.entries.some(e=>e.raw.type==='ADD_LOG'&&e.text.startsWith('[CODEX 分支')));if(turn){game=turn.game;selected=turn.id;renderGames();render();}}};
$('prompt-copy').onclick=async()=>{try{await navigator.clipboard.writeText(Branch.prompt());notify('提示词已复制。附上 codex-handoff.json 后交给 Codex。');}catch{$('handoff-prompt').closest('details').open=true;$('handoff-prompt').focus();$('handoff-prompt').select();notify('请复制选中的提示词。');}};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notify('浏览器未允许全屏，可使用浏览器的全屏快捷键。',true);}};
document.addEventListener('fullscreenchange',()=>$('fullscreen').textContent=document.fullscreenElement?'退出全屏 ⛶':'全屏 ⛶');
$('raw-kind').onchange=$('raw-search').oninput=renderRaw;$('save-jsonl').onclick=()=>exportFile('jsonl');
$('file').onchange=e=>openFile(e.target.files[0]);
$('home').onclick=e=>{e.preventDefault();if(model){$('landing').hidden=!$('landing').hidden;$('workspace').hidden=!$('landing').hidden;document.body.classList.toggle('has-replay',$('landing').hidden);}};
$('help').onclick=()=>$('help-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
$('games').onclick=e=>{const b=e.target.closest('[data-game]');if(b){game=Number(b.dataset.game);selected=gameTurns()[0].id;focused=-1;branchSnapshot=null;renderGames();render();}};
$('turns').onclick=e=>{const b=e.target.closest('[data-turn]');if(b)chooseTurn(Number(b.dataset.turn));};
$('events').onclick=e=>{const branch=e.target.closest('[data-ai-branch]');if(branch){globalThis.Studio?.openNode(Number(branch.dataset.aiBranch));return;}const b=e.target.closest('[data-entry]');if(b){focused=Number(b.dataset.entry);branchSnapshot=null;renderReading();renderBoard();}};
$('board-state').onclick=e=>{const b=e.target.closest('[data-card]');if(b)showCard(b.dataset.card);};
$('reset-state').onclick=()=>{focused=-1;branchSnapshot=null;renderReading();renderBoard();};
$('prev').onclick=()=>moveTurn(-1);$('next').onclick=()=>moveTurn(1);
$('detail').onclick=()=>{detailed=!detailed;$('detail').textContent=detailed?'完整记录':'精简记录';$('detail').setAttribute('aria-pressed',String(detailed));render();};
$('search').oninput=e=>{query=e.target.value.trim().toLowerCase();focused=-1;branchSnapshot=null;if(query){const turns=gameTurns();if(!model.turns[selected].entries.some(isShown)){const match=turns.find(t=>t.entries.some(isShown));if(match)selected=match.id;}}render();};
$('export').onclick=()=>{const v=!$('export-menu').hidden;$('export-menu').hidden=v;$('export').setAttribute('aria-expanded',String(!v));};
$('export-menu').onclick=e=>{const b=e.target.closest('[data-export]');if(b)exportFile(b.dataset.export);};
document.addEventListener('click',e=>{if(!e.target.closest('.export-wrap')){$('export-menu').hidden=true;$('export').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&model){e.preventDefault();$(view==='jsonl'?'raw-search':'search').focus();}if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;if(view==='report'&&model&&e.key==='ArrowLeft')moveTurn(-1);if(view==='report'&&model&&e.key==='ArrowRight')moveTurn(1);});
document.addEventListener('dragenter',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();dragCount++;$('drop').hidden=false;}});
document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{dragCount=Math.max(0,dragCount-1);if(!dragCount)$('drop').hidden=true;});
document.addEventListener('drop',e=>{e.preventDefault();dragCount=0;$('drop').hidden=true;const file=e.dataTransfer.files[0];if(file){if(file.name.toLowerCase().endsWith('.json'))readBranchFile(file).catch(error=>notify(error.message,true));else openFile(file);}});
if($('embedded-replay'))try{loadModel(JSON.parse($('embedded-replay').textContent));}catch(error){notify('内嵌战报读取失败：'+error.message,true);}
