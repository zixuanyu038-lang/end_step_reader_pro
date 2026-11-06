'use strict';
(function(){
  const el=id=>document.getElementById(id),html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={ready:false,loggedIn:false,replayId:null,model:null,review:null,line:null,route:[],edits:new Map(),plans:new Map(),job:null,poll:null,result:null,reviewPending:false,reviewRevision:null,evidence:[],deckProfiles:null,sideboardPlans:[],forgeInstalled:false,version:0};
  const actions={cast:'施放',activate:'起动异能',play_land:'下地',pass:'让过',phase:'推进阶段',choice:'选择',combat:'战斗'};
  const confidence={high:'较高',medium:'中等',low:'较低'},severity={mistake:'可改进',alternative:'可选路线',good:'合理操作'};
  async function api(url,options={}){
    const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Endstep-Request':'1',...options.headers}});
    const data=await response.json();if(!response.ok)throw Error(data.error||'后端请求失败。');return data;
  }
  function entryAt(line){for(const turn of model?.turns||[]){const index=turn.entries.findIndex(e=>e.sourceLine===line);if(index>=0)return{turn,index,entry:turn.entries[index]};}return null;}
  const findings=()=>state.review?.games.flatMap(g=>g.findings.map(f=>({...f,game:g.game})))||[];
  function controls(){const busy=state.job?.status==='running';el('studio-review').disabled=!state.ready||!state.loggedIn||!state.forgeInstalled||!state.replayId||busy;el('studio-review').textContent=state.review?'重新复盘 ↗':'生成整盘复盘 ↗';for(const id of ['studio-generate','studio-extract']){const b=el(id);if(b)b.disabled=!state.ready||!state.loggedIn||!state.forgeInstalled||!state.review||state.reviewPending||busy;}}
  function renderJob(){
    const job=state.job;el('studio-job').hidden=!job;if(!job){el('studio-game-stages').innerHTML='';controls();return;}
    el('studio-job').dataset.status=job.status;el('studio-job-label').textContent=(job.type==='review'?'整盘复盘':job.type==='plan'?'提炼新打法':'分支重演')+(job.createdAt?' · '+Math.floor(((job.status==='running'?Date.now():(job.events?.at(-1)?.at||Date.now()))-job.createdAt)/60000)+' 分钟':'');el('studio-job-message').textContent=job.error?job.message+'\n'+job.error:job.status==='complete'&&job.type==='review'?'已验证 '+(job.result?.evidence?.length||0)+' 个节点，保留 '+(job.result?.evidence?.filter(e=>e.quality?.keep).length||0)+' 条指导路线。':job.message;el('studio-cancel').hidden=job.status!=='running';el('studio-cancel').disabled=!job.id;el('studio-game-stages').innerHTML=(job.status==='running'?job.result?.gameStages||[]:[]).map(g=>'<div><b>第 '+g.game+' 局</b><span>'+html(g.message)+'</span></div>').join('');controls();
  }
  const playerName=id=>state.model?.header.players.find(p=>String(p.seat)===String(id))?.name||id;
  const cardList=cards=>(cards||[]).map(c=>html(c.count+' × '+c.name)).join('<br>');
  function sourceLink(url){return /^https:\/\//.test(url||'')?'<a href="'+html(url)+'" target="_blank" rel="noreferrer">参考牌表 ↗</a>':html(url||'来自回放记录');}
  function evidenceDetails(){
    const profiles=state.deckProfiles,plans=state.sideboardPlans.length?state.sideboardPlans:profiles?.sideboardPlans||[];
    const decks=profiles?.byGame?'<details class="review-evidence"><summary>牌表与换备</summary><p class="step-description">牌表按整盘公开信息还原。你的实际换备优先保留；对手换备为 AI 推定。</p>'+Object.entries(profiles.byGame).map(([g,ds])=>'<details><summary>第 '+g+' 局</summary><div class="deck-columns">'+ds.map(d=>'<div><h4>'+html(playerName(d.playerId??ds.indexOf(d)))+'</h4><p>'+html(d.archetype||'录制牌表')+' · '+sourceLink(d.url)+'</p><p class="step-description">'+html(d.basis)+'</p><details><summary>主牌 '+d.main.reduce((n,c)=>n+c.count,0)+' / 备牌 '+d.sideboard.reduce((n,c)=>n+c.count,0)+'</summary><div class="deck-list">'+cardList(d.main)+'<hr>'+cardList(d.sideboard)+'</div></details>'+(d.adjustments?.length?'<p class="step-description">推定调整：'+html(d.adjustments.map(a=>(a.removed||'空位')+' → '+(a.added||'移除')).join('；'))+'</p>':'')+'</div>').join('')+'</div>'+plans.filter(p=>String(p.game)===g).map(p=>'<div class="sideboard-plan"><h4>'+html(playerName(p.playerId))+' · AI 换备建议</h4><p>'+html((p.swaps||[]).map(c=>c.count+' × '+c.outName+' → '+c.inName).join('；')||'不换牌')+'</p><p>'+html(p.reason)+'</p><small>'+html(p.uncertainties.join('；'))+'</small></div>').join('')+'</details>').join('')+'</details>':'';
    const ev=state.evidence||[];
    return decks+(ev.length?'<details class="review-evidence"><summary>搜索依据 · '+ev.length+' 个节点</summary><p class="step-description">以下为有限候选、有限深度下的启发式比较，评分不是胜率。每个节点使用同一副牌表，比较三组固定手牌与库序；包含明确标注的压力情景。</p>'+ev.map(e=>'<details><summary>第 '+e.game+' 局 · '+html(e.question)+' · '+e.simulated+' 次模拟</summary><p>胜局候选 '+(e.winningCandidates||0)+' · '+html(e.quality?.reason||'正在筛选')+'</p><div class="evidence-table-wrap"><table><thead><tr><th>节点选择</th><th>平均评分</th><th>访问次数</th></tr></thead><tbody>'+e.alternatives.slice(0,5).map(a=>'<tr><td>'+html(a.action.label||a.action.cardName||'让过')+'</td><td>'+Math.round(a.mean)+'</td><td>'+a.visits+'</td></tr>').join('')+'</tbody></table></div><p class="step-description">'+html(e.limitations.join('；'))+'</p></details>').join('')+'</details>':'');
  }
  function renderOverview(){
    const review=state.review;el('studio-overview').hidden=!review;if(!review)return;
    el('studio-overview').innerHTML=`<p class="review-summary">${html(review.summary)}</p><details class="review-evidence"><summary>逐局复盘与整体计划</summary><p>${html(review.overallPlan)}</p><div class="review-game-summaries">${review.games.map(g=>`<div><h3>第 ${g.game} 局</h3><p>${html(g.summary)}</p></div>`).join('')}</div><ol>${review.takeaways.map(t=>`<li>${html(t)}</li>`).join('')}</ol></details>${evidenceDetails()}`;
  }
  function renderNodes(){
    const list=findings(),extra=state.line&&!list.some(f=>f.sourceLine===state.line)?entryAt(state.line):null;
    el('review-nodes').innerHTML=list.length?list.map(f=>`<button class="review-node-link ${f.sourceLine===state.line?'active':''}" data-review-line="${f.sourceLine}" aria-pressed="${f.sourceLine===state.line}"><small>第 ${f.game} 局 · ${Replay.clock(entryAt(f.sourceLine)?.entry.t||0)} · ${severity[f.severity]}</small><span>${html(f.title)}</span></button>`).join(''):'<p class="step-description">先生成整盘复盘。你选中的战报操作会保留在这里。</p>';
    if(extra)el('review-nodes').innerHTML+=`<button class="review-node-link active" data-review-line="${state.line}" aria-pressed="true"><small>第 ${extra.turn.game} 局 · ${Replay.clock(extra.entry.t)}</small><span>${html(extra.entry.text.split('\n')[0])}</span></button>`;
  }
  function preserveEdits(){if(state.line){state.edits.set(state.line,el('studio-intent')?.value??state.edits.get(state.line)??'');if(state.replayId)try{sessionStorage.setItem('endstep-intents:'+state.replayId,JSON.stringify([...state.edits]));}catch{}}}
  function manaOwner(cardId){const selected=entryAt(state.line),snapshot=state.model?.states[selected?.entry.stateIndex];return snapshot?.players.find(p=>p.battlefield.some(c=>String(c.id)===String(cardId)))?.name||'';}
  function renderRoute(){
    const node=el('route-editor');if(!node)return;
    node.innerHTML=state.route.length?'<ol class="proposed-line">'+state.route.map(s=>'<li><b>'+html(model.header.players.find(p=>String(p.seat)===s.actorId)?.name||s.actorId)+' · '+html(actions[s.action])+' '+html(s.cardName)+'</b><p>'+html(s.description)+'</p><small>支付：'+html(s.payment)+'</small></li>').join('')+'</ol>':'<p class="step-description">先描述你希望改变的打法，AI 会提炼为具体动作。</p>';
  }
  function renderNode(){
    const selected=entryAt(state.line);if(!selected)return;
    const original=findings().find(f=>f.sourceLine===state.line),plan=state.plans.get(state.line),f=plan?{...original,title:original?.title||'新打法',observed:original?.observed||selected.entry.text,analysis:original?.analysis||'',recommended:plan.understoodIntent,confidence:'medium',hiddenInformation:plan.assumptionsNeeded,manaAudit:plan.manaAudit}:original,audit=f?.manaAudit;
    const hidden=state.review?.hiddenHands.filter(h=>h.sourceLine===state.line)||[],retained=state.evidence.find(e=>e.sourceLine===state.line&&e.quality?.keep&&e.downloadUrl);
    el('review-node').innerHTML=`<div class="review-node-heading"><div><p class="eyebrow">第 ${selected.turn.game} 局 / T${selected.turn.number} / ${Replay.clock(selected.entry.t)}</p><h3>${html(f?.title||'从这一步重新选择')}</h3></div><div class="node-links"><button id="studio-locate" class="text-button">查看原局 ↗</button>${retained?`<a class="text-button" href="${html(retained.downloadUrl)}" download>下载已筛选回放 ↓</a>`:''}</div></div><p class="original-action"><span>原操作</span>${html(f?.observed||selected.entry.text.split('\n')[0])}</p>${f?`<p class="review-analysis">${html(f.analysis)}</p><p class="review-recommendation">${html(f.recommended)}</p><p class="review-confidence">判断置信度：${confidence[f.confidence]}${(f.hiddenInformation||[]).length?' · 涉及隐藏信息':''}</p>`:'<p class="step-description">'+(state.review?'此操作未单独列为关键失误。可以描述新打法，再让 AI 重演。':'请先完成整盘复盘，再根据分析编辑或生成分支。')+'</p>'}${audit?`<details class="mana-audit"><summary>法术力与费用核对</summary><div class="mana-sources">${audit.availableSources.map(s=>`<div><b>${html(s.name)}</b><span>${html(manaOwner(s.cardId))} · ${s.tapped?'已横置':s.amount+' × '+s.colors.join('/')} </span></div>`).join('')}</div><dl><dt>法术力池</dt><dd>${html(audit.availablePool)}</dd><dt>费用</dt><dd>${html(audit.spellCost)}</dd><dt>费用修正</dt><dd>${html(audit.modifiers.join('；')||'无')}</dd><dt>支付顺序</dt><dd>${html(audit.paymentPlan.join(' → '))}</dd><dt>支付后剩余</dt><dd>${html(audit.remainingMana)}</dd></dl>${audit.uncertainties.length?`<p class="audit-uncertainties">待确认：${html(audit.uncertainties.join('；'))}</p>`:''}</details>`:''}${hidden.length?`<details class="hidden-hand-notes"><summary>可能的对手手牌 · 假设</summary>${hidden.map(h=>`<p><b>${html(h.cards.map(c=>(c.count>1?c.count+' × ':'')+c.name).join(' / '))}</b><br>${html(h.basis)}<small>置信度 ${confidence[h.confidence]} · 其他候选：${html(h.alternatives.join(' / '))}</small></p>`).join('')}</details>`:''}<section class="route-section"><h4>你想怎样改变这一步</h4><p class="step-description">描述你希望怎样打，AI 提炼目标，Forge 执行费用、优先权与双方后续。</p><textarea id="studio-intent" rows="4" placeholder="例如：这里不施放 Brainstorm，先施放 Tamiyo, Inquisitive Student，保留 Flame of Anor 应对。">${html(state.edits.get(state.line)||'')}</textarea><div class="intent-actions"><button id="studio-extract" class="import-button">提炼新打法 ↗</button><button id="studio-generate" class="primary">补全并重演 ↗</button></div>${plan?.quality?.keep===false?`<p class="intent-issues">未保留这条路线：${html(plan.quality.reason)}</p>`:''}${plan&&!plan.feasible?`<p class="intent-issues">${html(plan.issues.join('；'))}</p>`:''}<details class="execution-details"${plan?' open':''}><summary>${plan?'AI 提炼的新打法':'实际执行顺序与支付'}</summary><div id="route-editor"></div></details><p class="step-description">可以继续描述修改后重新提炼；重演时会推断隐藏手牌，并补全双方后续。</p></section>`;
    renderRoute();controls();
  }
  function openNode(line,reveal=true){
    if(!entryAt(line))return;preserveEdits();state.line=line;
    const f=findings().find(f=>f.sourceLine===line);state.route=(state.plans.get(line)?.proposedLine||f?.proposedLine||[]).map(s=>({...s}));
    switchView('codex');renderNodes();renderNode();if(reveal)el('review-node').scrollIntoView({block:'nearest'});
  }
  function locate(){const found=entryAt(state.line);if(!found)return;game=found.turn.game;selected=found.turn.id;focused=found.index;branchSnapshot=null;query='';el('search').value='';if(!Replay.visible(found.entry,detailed)){detailed=true;el('detail').textContent='完整记录';el('detail').setAttribute('aria-pressed','true');}renderGames();render();switchView('report');revealSelectedTurn();el('events').querySelector(`[data-entry="${focused}"]`)?.scrollIntoView({block:'center'});}
  function renderResult(){
    const r=state.result;el('studio-result').hidden=!r;if(!r)return;
    const engine=r.validationLevel==='forge-executed-audited-root';
    el('studio-result').innerHTML='<p class="eyebrow">'+(r.complete?'本局完整假设后续':'搜索片段 · 未到终局')+'</p><h3>'+html(r.title)+'</h3><p>'+html(r.summary)+'</p>'+(r.quality?.keep?'<p class="review-recommendation">AI 胜局二筛：'+html(r.quality.reason)+'</p>':'')+'<div class="studio-downloads"><a class="primary" href="'+html(r.downloadUrl)+'" download>下载 '+(r.complete?'本局完整回放':'搜索片段')+' .esreplay ↓</a><a class="text-button" href="https://endstep.cc/replay/local" target="_blank" rel="noreferrer">在 Endstep 打开 ↗</a></div>'+((r.intentStatus?.blocked||[]).length?'<p class="intent-issues">部分目标未能完成：'+html(r.intentStatus.blocked.join('；'))+'</p>':'')+'<details class="result-assumptions"><summary>固定手牌与推演假设</summary>'+(r.hiddenHands||[]).map(h=>'<p><b>'+html(playerName(h.playerId))+'</b>：'+html(h.cards.join(' / '))+'</p>').join('')+(r.assumptions||[]).map(a=>'<p>'+html(a.basis)+'</p>').join('')+'</details><details><summary>执行记录</summary><p>'+html(r.verification)+'</p><p>'+(engine?'由 Forge 2.0.15 执行，起点经过恢复核对。结论仅属于选定的隐藏信息假设，不能当作原局真实后续或胜率。':'此文件来自旧版模型推演流程，未经 Forge 执行。')+'</p></details>';
  }
  function acceptEvidence(data){
    if(data.evidence&&!data.downloadUrl)state.evidence=data.evidence;
    if(data.deckProfiles)state.deckProfiles=data.deckProfiles;
    if(data.sideboardPlans)state.sideboardPlans=data.sideboardPlans;
  }
  async function watch(id,version=state.version){
    clearTimeout(state.poll);
    try{
      const job=await api('/api/jobs/'+id);if(version!==state.version)return;state.job=job;acceptEvidence(job.result||{});renderJob();
      if(job.result?.review&&(job.status==='complete'||state.reviewRevision!==job.id+':'+job.result.reviewRevision)){preserveEdits();state.review=job.result.review;state.reviewPending=!!job.result.reviewPending;state.reviewRevision=job.id+':'+job.result.reviewRevision;renderOverview();if(!state.line)state.line=findings().find(f=>f.severity==='mistake')?.sourceLine||findings()[0]?.sourceLine;const f=findings().find(f=>f.sourceLine===state.line);state.route=(state.plans.get(state.line)?.proposedLine||f?.proposedLine||[]).map(s=>({...s}));renderNodes();renderNode();}
      if(job.status==='running'){state.poll=setTimeout(()=>watch(id,version),1500);return;}
      if(job.status==='complete'){
        
        if(job.result.plan){state.plans.set(job.sourceLine,{...job.result.plan,quality:job.result.quality||null});if(state.line===job.sourceLine){state.route=job.result.plan.proposedLine;renderNode();}}
        if(job.result.downloadUrl){state.result=job.result;renderResult();el('studio-result').scrollIntoView({block:'nearest'});}
      }
    }catch(error){if(version!==state.version)return;el('studio-job-message').textContent='连接暂时中断，正在重连…';state.poll=setTimeout(()=>watch(id,version),4000);}
  }
  async function submit(type){
    try{
      preserveEdits();const intent=el('studio-intent')?.value||'';
      state.job={type,status:'running',message:'正在提交任务…'};renderJob();
      state.job=await api('/api/jobs',{method:'POST',body:JSON.stringify({type,replayId:state.replayId,sourceLine:type==='review'?null:state.line,focus:intent})});renderJob();watch(state.job.id);
    }catch(error){state.job={type,status:'failed',message:'提交失败。',error:error.message};renderJob();notify(error.message,true);}
  }
  async function onModel(next){
    const version=++state.version;clearTimeout(state.poll);state.model=next;state.evidence=[];state.deckProfiles=null;state.sideboardPlans=[];state.replayId=null;state.review=null;state.line=null;state.route=[];state.edits.clear();state.plans.clear();state.job=null;state.result=null;state.reviewPending=false;state.reviewRevision=null;renderOverview();renderNodes();renderResult();renderJob();
    el('review-node').innerHTML='<div class="review-placeholder"><h3>先完成整盘复盘</h3><p>核对资源和费用，再选择关键节点，编辑新打法或让 AI 重演。</p></div>';
    if(!state.ready)return;
    try{const registered=await api('/api/replays',{method:'POST',body:JSON.stringify({filename:next.filename||'replay.esreplay',jsonl:next.sourceText})});if(version!==state.version)return;state.replayId=registered.id;try{state.edits=new Map(JSON.parse(sessionStorage.getItem('endstep-intents:'+state.replayId)||'[]'));}catch{}state.review=registered.review;acceptEvidence(registered);renderOverview();renderNodes();controls();switchView('codex');if(findings().length)openNode(findings()[0].sourceLine,false);}catch(error){notify('后端导入失败：'+error.message,true);}
  }
  el('studio-review').onclick=()=>submit('review');
  el('studio-cancel').onclick=async()=>{if(state.job)try{await api('/api/jobs/'+state.job.id,{method:'DELETE'});}catch(e){notify(e.message,true);}};
  el('review-nodes').onclick=e=>{const b=e.target.closest('[data-review-line]');if(b)openNode(Number(b.dataset.reviewLine));};
  el('review-node').addEventListener('input',e=>{if(e.target.id==='studio-intent')preserveEdits();});
  el('review-node').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.id==='studio-locate')locate();
    if(b.id==='studio-generate')submit('branch');
    if(b.id==='studio-extract')submit('plan');
  });
  globalThis.Studio={onModel:next=>(state.modelTask=onModel(next)),openNode,state};
  async function boot(){
    if(!['http:','https:'].includes(location.protocol)){el('codex-connection').textContent='需启动本地后端';el('manual-workflow').hidden=false;el('studio-review').disabled=true;el('studio-job').hidden=false;el('studio-job-message').textContent='请运行 start.ps1 启动应用；双击 HTML 不能调用 Codex。';el('studio-cancel').hidden=true;return;}
    try{
      const health=await api('/api/health');state.ready=health.connected;state.loggedIn=health.loggedIn;state.forgeInstalled=!!health.forge?.installed;el('codex-connection').textContent=health.connected?(health.loggedIn?'Codex 已连接':'Codex 尚未登录'):'Codex 连接失败';el('codex-connection').classList.toggle('connected',state.ready&&state.loggedIn);el('studio-model').textContent=health.model?'模型：'+health.model+' · 推理：'+(health.reasoningEffort||'默认'):'模型：沿用本机 Codex 配置';el('studio-model').textContent+=' · '+(state.forgeInstalled?'Forge 2.0.15':'Forge 未安装，请运行安装Forge.cmd');controls();
      const current=await api('/api/current');if(current){loadModel(Replay.parse(current.jsonl,current.filename));await state.modelTask;acceptEvidence(current);renderOverview();current.jobs.sort((a,b)=>a.createdAt-b.createdAt);const recent=current.jobs.filter(j=>j.status==='running').at(-1)||current.jobs.filter(j=>j.status==='complete').at(-1);if(recent){if(recent.sourceLine&&entryAt(recent.sourceLine)){state.edits.set(recent.sourceLine,state.edits.get(recent.sourceLine)||recent.intent||'');openNode(recent.sourceLine,false);}watch(recent.id);}}
      else if(model)await onModel(model);
    }catch(error){state.ready=false;el('codex-connection').textContent='后端未连接';el('studio-job').hidden=false;el('studio-job-message').textContent=error.message;el('studio-cancel').hidden=true;controls();}
  }
  boot();
})();
