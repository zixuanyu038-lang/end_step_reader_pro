'use strict';
(function(){
  const el=id=>document.getElementById(id),html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={ready:false,loggedIn:false,replayId:null,model:null,review:null,shortlist:null,line:null,route:[],edits:new Map(),stressDrafts:new Map(),plans:new Map(),branchChecks:new Map(),job:null,poll:null,result:null,reviewPending:false,reviewRevision:null,evidence:[],deckProfiles:null,sideboardPlans:[],forgeInstalled:false,version:0};
  const actions={cast:'施放',activate:'起动异能',play_land:'下地',pass:'让过',phase:'推进阶段',choice:'选择',combat:'战斗'};
  const confidence={high:'较高',medium:'中等',low:'较低'},severity={mistake:'可改进',alternative:'可选路线',good:'合理操作'};
  async function api(url,options={}){
    const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Endstep-Request':'1',...options.headers}});
    const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'后端请求失败。'),{status:response.status});return data;
  }
  function entryAt(line){for(const turn of model?.turns||[]){const index=turn.entries.findIndex(e=>e.sourceLine===line);if(index>=0)return{turn,index,entry:turn.entries[index]};}return null;}
  const findings=()=>state.review?.games.flatMap(g=>g.findings.map(f=>({...f,game:g.game})))||[];
  const deckSides=['own','opponent'];
  const branchLabels={ready:'可恢复',unsupported:'不可直接恢复',unavailable:'校验暂不可用',checking:'正在校验',unchecked:'待校验'};
  const branchStatus=line=>state.branchChecks.get(line)?.status||'unchecked';
  const branchBadge=line=>`<small class="branch-badge" data-branch-state="${branchStatus(line)}">${branchLabels[branchStatus(line)]}</small>`;
  const jobNames={review:'整盘复盘',prepare:'准备对局',shortlist:'AI 初筛',plan:'提炼新打法',search:'Forge 搜索',quality:'AI 二筛',branch:'分支重演'};
  function controls(){
    const busy=state.job?.status==='running';
    const inputs=el('studio-deck-sources');inputs.hidden=!state.replayId;inputs.disabled=busy;
    let needsFile=false,showFormat=false;
    for(const side of deckSides){
      const upload=el('studio-deck-mode-'+side).value==='upload',file=el('studio-deck-file-'+side);
      file.hidden=!upload;showFormat||=upload;needsFile||=upload&&!file.files.length;
    }
    el('studio-deck-format').hidden=!showFormat;
    const modelAvailable=state.ready&&state.loggedIn&&state.replayId&&!busy;
    const available=modelAvailable&&state.forgeInstalled;
    el('studio-review').disabled=el('studio-prepare').disabled=!available||needsFile;
    el('studio-sideboard-fields').disabled=busy;
    el('studio-apply-sideboard').disabled=!available||needsFile;
    el('studio-shortlist').disabled=!modelAvailable;
    el('studio-prepare').textContent=state.deckProfiles?'重新准备':'准备对局';
    el('studio-preparation-note').textContent=state.deckProfiles?'对局已准备。可从中文战报选节点，或查看 AI 初筛结果。':'准备牌表后，可以直接从战报选节点，也可以让 AI 初筛。';
    el('studio-review').textContent=state.review?'重新复盘 ↗':'生成整盘复盘 ↗';
    const hasIntent=state.review||el('studio-intent')?.value.trim();
    for(const id of ['studio-generate','studio-extract']){const b=el(id);if(b)b.disabled=!available||!state.deckProfiles||state.reviewPending||!hasIntent||branchStatus(state.line)!=='ready';}
    const quality=el('studio-screen-search');if(quality)quality.disabled=!available;
  }
  function renderBranchStart(){
    const panel=el('studio-branch-start');if(!panel)return;
    const check=state.branchChecks.get(state.line),status=branchStatus(state.line);
    const text=!state.deckProfiles?'准备对局后，才能校验这个起点。':state.reviewPending?'正在更新复盘，完成后可校验起点。':!state.forgeInstalled?'安装 Forge 后，才能校验这个起点。':check?.reason||(status==='ready'?'可以从这项原操作之前开始重演。':'正在核对起点的公开局面、优先权和堆叠。');
    const earlier=check?.earlier;
    const alternative=earlier?`<p>已核对的前置起点为第 ${earlier.game} 局 T${earlier.turn}，${html(earlier.cardName)} 之前（${Replay.clock(earlier.t)}）。切换后从该点开始重演。</p><button type="button" class="text-button" id="studio-earlier-branch" data-line="${earlier.sourceLine}">切换到前置起点 ↗</button>`:status==='unsupported'?'<p>附近未找到已通过校验的前置起点。</p>':'';
    const retry=status==='unavailable'?'<button type="button" class="text-button" id="studio-retry-branch-check">重新校验 ↻</button>':'';
    panel.innerHTML=`${branchBadge(state.line)}<p>${html(text)}</p>${alternative}${retry}`;
  }
  async function checkSelectedBranch({retry=false}={}){
    const line=state.line,checks=state.branchChecks;
    if(!line||!state.replayId||!state.deckProfiles||state.reviewPending||!state.forgeInstalled||(!retry&&checks.has(line)))return;
    function update(check){
      if(checks!==state.branchChecks)return;
      checks.set(line,check);
      const badge=el('review-nodes').querySelector(`[data-review-line="${line}"] .branch-badge`);
      if(badge){badge.dataset.branchState=check.status;badge.textContent=branchLabels[check.status];}
      if(state.line===line){renderBranchStart();controls();}
      if(view==='report')renderReading();
    }
    update({status:'checking'});
    try{update(await api(`/api/replays/${state.replayId}/branch-start?line=${line}`));}
    catch(error){update({status:'unavailable',reason:error.message});}
  }
  async function reviewDeckPreferences(){
    const own=Number(state.model.header.seat),preferences={};
    for(const side of deckSides){
      const seat=side==='own'?own:1-own,mode=el('studio-deck-mode-'+side).value;
      preferences[seat]={mode};
      if(mode==='upload'){
        const file=el('studio-deck-file-'+side).files[0];
        if(!file||file.size>128*1024)throw Error('请选择 128 KB 以内的英文纯文本牌表。');
        preferences[seat].text=await file.text();
      }
    }
    return preferences;
  }
  function renderManualSideboard(plans=[]){
    const games=[...new Set((state.model?.turns||[]).map(turn=>turn.game))].filter(game=>game>1);
    el('studio-sideboard').hidden=!state.replayId||!games.length;
    const own=Number(state.model?.header.seat);
    const lineText=cards=>(cards||[]).map(c=>c.count+' '+c.name).join('\n');
    el('studio-sideboard-games').innerHTML=games.map(game=>`<section><h3>第 ${game} 局</h3><div class="sideboard-inputs">${[own,1-own].map((seat,index)=>{
      const plan=plans.find(p=>p.game===game&&p.playerId===String(seat));
      return `<div data-sideboard-game="${game}" data-seat="${seat}"><label><input type="checkbox"${plan?' checked':''}> 手动指定${index?'对手':'己方'}</label><div class="sideboard-cards"${plan?'':' hidden'}><label>换入<textarea rows="3" data-sideboard-in placeholder="2 Pyroblast">${html(lineText(plan?.ins))}</textarea></label><label>换出<textarea rows="3" data-sideboard-out placeholder="2 Force of Will">${html(lineText(plan?.outs))}</textarea></label></div></div>`;
    }).join('')}</div></section>`).join('');
  }
  function manualSideboard(){
    return Array.from(el('studio-sideboard-games').querySelectorAll('[data-sideboard-game]')).filter(row=>row.querySelector('input').checked).map(row=>({
      game:Number(row.dataset.sideboardGame),playerId:row.dataset.seat,inText:row.querySelector('[data-sideboard-in]').value,outText:row.querySelector('[data-sideboard-out]').value
    }));
  }
  function renderJob(){
    const job=state.job;renderNodeJob();el('studio-job').hidden=!job;if(!job){el('studio-game-stages').innerHTML='';controls();return;}
    el('studio-job').dataset.status=job.status;el('studio-job-label').textContent=(jobNames[job.type]||'复盘任务')+(job.reviewOptions?.searchMode==='deep'?' · 暴力大算':'')+(job.createdAt?' · '+Math.floor(((job.status==='running'?Date.now():(job.events?.at(-1)?.at||Date.now()))-job.createdAt)/60000)+' 分钟':'');el('studio-job-message').textContent=job.error?job.message+'\n'+job.error:job.status==='complete'&&job.type==='review'?'已搜索 '+(job.result?.evidence?.length||0)+' 个节点，跳过 '+(job.result?.unsupported?.length||0)+' 个不可恢复节点，保留 '+(job.result?.evidence?.filter(e=>e.quality?.keep).length||0)+' 条指导路线。':job.message;el('studio-cancel').hidden=job.status!=='running';el('studio-cancel').disabled=!job.id;el('studio-game-stages').innerHTML=(job.status==='running'?job.result?.gameStages||[]:[]).map(g=>'<div><b>第 '+g.game+' 局</b><span>'+html(g.message)+'</span></div>').join('');controls();
  }
  function renderNodeJob(){
    const status=el('studio-node-job');if(!status)return;
    const job=state.job,applies=job?.sourceLine===state.line&&['plan','search','branch','quality'].includes(job.type);
    status.hidden=!applies;
    if(applies){status.dataset.status=job.status;status.textContent=job.error?job.message+' '+job.error:job.message;}
  }
  const playerName=id=>state.model?.header.players.find(p=>String(p.seat)===String(id))?.name||id;
  const cardList=cards=>(cards||[]).map(c=>html(c.count+' × '+c.name)).join('<br>');
  function sourceLink(deck){
    if(deck.sourceKind==='uploaded')return '本机文件';
    const url=deck.url;
    return /^https:\/\//.test(url||'')?'<a href="'+html(url)+'" target="_blank" rel="noreferrer">'+(deck.lookup==='local-catalog'?'本地赛事参考':deck.lookup==='web'?'联网赛事参考':'参考牌表')+' ↗</a>':'来自回放记录';
  }
  function evidenceDetails(){
    const profiles=state.deckProfiles,plans=state.sideboardPlans.length?state.sideboardPlans:profiles?.sideboardPlans||[];
    const decks=profiles?.byGame?'<details class="review-evidence"><summary>牌表与换备</summary><p class="step-description">参考牌表按整盘公开信息还原。已应用的手动换备优先用于推演，其余采用录制或推定方案。</p>'+Object.entries(profiles.byGame).map(([g,ds])=>'<details><summary>第 '+g+' 局</summary><div class="deck-columns">'+ds.map(d=>'<div><h4>'+html(playerName(d.playerId??ds.indexOf(d)))+'</h4><p>'+html(d.archetype||'录制牌表')+' · '+sourceLink(d)+'</p><p class="step-description">'+html(d.basis)+'</p><details><summary>主牌 '+d.main.reduce((n,c)=>n+c.count,0)+' / 备牌 '+d.sideboard.reduce((n,c)=>n+c.count,0)+'</summary><div class="deck-list">'+cardList(d.main)+'<hr>'+cardList(d.sideboard)+'</div></details>'+(d.adjustments?.length?'<p class="step-description">推定调整：'+html(d.adjustments.map(a=>(a.removed||'空位')+' → '+(a.added||'移除')).join('；'))+'</p>':'')+'</div>').join('')+'</div>'+plans.filter(p=>String(p.game)===g).map(p=>'<div class="sideboard-plan"><h4>'+html(playerName(p.playerId))+' · '+(p.manual?'手动换备':'AI 换备建议')+'</h4><p>'+html((p.manual?[...(p.outs||[]).map(c=>'换出 '+c.count+' × '+c.name),...(p.ins||[]).map(c=>'换入 '+c.count+' × '+c.name)]:(p.swaps||[]).map(c=>c.count+' × '+c.outName+' → '+c.inName)).join('；')||'不换牌')+'</p><p>'+html(p.reason)+'</p><small>'+html(p.uncertainties.join('；'))+'</small></div>').join('')+'</details>').join('')+'</details>':'';
    const ev=state.evidence||[];
    return decks+(ev.length?'<details class="review-evidence"><summary>搜索依据 · '+ev.length+' 个节点</summary><p class="step-description">以下为有限候选、有限深度下的启发式比较，评分不是胜率。每个节点使用同一副牌表，比较三组固定手牌与库序；包含明确标注的压力情景。</p>'+ev.map(e=>'<details><summary>第 '+e.game+' 局 · '+html(e.question)+' · '+e.simulated+' 次模拟</summary>'+(e.searchElapsedMs!=null?'<p>规则搜索用时 '+(e.searchElapsedMs/1000).toFixed(1)+' 秒（不含模型分析与二筛）</p>':'')+'<p>胜局候选 '+(e.winningCandidates||0)+' · '+html(e.quality?.reason||'正在筛选')+'</p><div class="evidence-table-wrap"><table><thead><tr><th>节点选择</th><th>平均评分</th><th>访问次数</th></tr></thead><tbody>'+e.alternatives.slice(0,5).map(a=>'<tr><td>'+html(a.action.label||a.action.cardName||'让过')+'</td><td>'+Math.round(a.mean)+'</td><td>'+a.visits+'</td></tr>').join('')+'</tbody></table></div><p class="step-description">'+html(e.limitations.join('；'))+'</p></details>').join('')+'</details>':'');
  }
  function renderOverview(){
    const review=state.review;el('studio-overview').hidden=!review&&!state.shortlist&&!state.deckProfiles;
    if(!review){el('studio-overview').innerHTML=(state.shortlist?`<p class="review-summary">${html(state.shortlist.summary)}</p>`:'')+evidenceDetails();return;}
    el('studio-overview').innerHTML=`<p class="review-summary">${html(review.summary)}</p><details class="review-evidence"><summary>逐局复盘与整体计划</summary><p>${html(review.overallPlan)}</p><div class="review-game-summaries">${review.games.map(g=>`<div><h3>第 ${g.game} 局</h3><p>${html(g.summary)}</p></div>`).join('')}</div><ol>${review.takeaways.map(t=>`<li>${html(t)}</li>`).join('')}</ol></details>${evidenceDetails()}`;
  }
  function renderNodes(){
    const reviewed=findings(),list=reviewed.concat((state.shortlist?.nodes||[]).filter(node=>!reviewed.some(f=>f.sourceLine===node.sourceLine))),extra=state.line&&!list.some(f=>f.sourceLine===state.line)?entryAt(state.line):null;
    el('review-nodes').innerHTML=list.length?list.map(f=>`<button class="review-node-link ${f.sourceLine===state.line?'active':''}" data-review-line="${f.sourceLine}" aria-pressed="${f.sourceLine===state.line}"><small>第 ${f.game} 局 · ${Replay.clock(entryAt(f.sourceLine)?.entry.t||0)} · ${severity[f.severity]||'AI 初筛'}</small><span>${html(f.title||f.question)}</span>${branchBadge(f.sourceLine)}</button>`).join(''):'<p class="step-description">可从中文战报选节点，也可先运行 AI 初筛。</p>';
    if(extra)el('review-nodes').innerHTML+=`<button class="review-node-link active" data-review-line="${state.line}" aria-pressed="true"><small>第 ${extra.turn.game} 局 · ${Replay.clock(extra.entry.t)}</small><span>${html(extra.entry.text.split('\n')[0])}</span>${branchBadge(state.line)}</button>`;
  }
  function preserveEdits(){
    if(!state.line)return;
    state.edits.set(state.line,el('studio-intent')?.value??state.edits.get(state.line)??'');
    const pressure=el('studio-stress-cards');if(pressure)state.stressDrafts.set(state.line,pressure.value);
    if(state.replayId)try{
      sessionStorage.setItem('endstep-intents:'+state.replayId,JSON.stringify([...state.edits]));
      sessionStorage.setItem('endstep-pressure:'+state.replayId,JSON.stringify([...state.stressDrafts]));
    }catch{}
  }
  function manaOwner(cardId){const selected=entryAt(state.line),snapshot=state.model?.states[selected?.entry.stateIndex];return snapshot?.players.find(p=>p.battlefield.some(c=>String(c.id)===String(cardId)))?.name||'';}
  function renderRoute(){
    const node=el('route-editor');if(!node)return;
    node.innerHTML=state.route.length?'<ol class="proposed-line">'+state.route.map(s=>'<li><b>'+html(model.header.players.find(p=>String(p.seat)===s.actorId)?.name||s.actorId)+' · '+html(actions[s.action])+' '+html(s.cardName)+'</b><p>'+html(s.description)+'</p><small>支付：'+html(s.payment)+'</small></li>').join('')+'</ol>':'<p class="step-description">先描述你希望改变的打法，AI 会提炼为具体动作。</p>';
  }
  function pressureComparison(result){
    if(!result)return '';
    const outcomes={horizon:'达到预演回合上限',game_over:'对局结束',choice_budget:'达到选择上限',step_budget:'达到步骤上限',trace_budget:'达到记录上限'};
    const describe=run=>{
      if(run.unavailable)return '原操作无法核对。'+run.unavailable;
      const life=run.life.map(p=>playerName(p.id)+' '+p.life+' 点生命').join(' / ');
      return `T${run.turn} · ${outcomes[run.stopReason]||'预演结束'} · ${life}${run.winnerId!=null?' · '+playerName(run.winnerId)+' 获胜':''}`;
    };
    return `<div class="pressure-comparison"><h4>同一压力世界的短程预演</h4><p>对手未知手牌假设 ${html(result.cards.join(' / '))}</p><dl><dt>原打法</dt><dd>${html(describe(result.original))}</dd><dt>替代打法</dt><dd>${html(describe(result.alternative))}</dd></dl></div>`;
  }
  function searchDetails(plan){
    const summary=plan?.searchSummary;if(!summary)return '';
    const seconds=Number.isFinite(summary.elapsedMs)?` · ${(summary.elapsedMs/1000).toFixed(1)} 秒`:'';
    const actions=summary.alternatives?.length?`<ul>${summary.alternatives.map(a=>`<li>${html(a.label)} · 评分 ${Math.round(a.mean)} · ${a.visits} 次访问</li>`).join('')}</ul>`:'';
    const screen=summary.winningCandidates&&plan.searchJobId&&!plan.quality?`<button type="button" id="studio-screen-search" class="import-button" data-job="${html(plan.searchJobId)}">AI 二筛并生成回放 ↗</button>`:'';
    return `<div class="pressure-comparison"><h4>Forge 搜索结果</h4><p>${summary.worlds} 组世界 · ${summary.simulated} 次模拟 · ${summary.winningCandidates} 条胜局候选${seconds}</p>${actions}${screen}</div>`;
  }
  function renderNode(){
    const selected=entryAt(state.line);if(!selected)return;
    const original=findings().find(f=>f.sourceLine===state.line),plan=state.plans.get(state.line),f=plan?{...original,title:original?.title||'新打法',observed:original?.observed||selected.entry.text,analysis:original?.analysis||'',recommended:plan.understoodIntent,confidence:'medium',hiddenInformation:plan.assumptionsNeeded,manaAudit:plan.manaAudit}:original,audit=f?.manaAudit;
    const hidden=state.review?.hiddenHands.filter(h=>h.sourceLine===state.line)||[],retained=state.evidence.find(e=>e.sourceLine===state.line&&e.quality?.keep&&e.downloadUrl);
    el('review-node').innerHTML=`<div class="review-node-heading"><div><p class="eyebrow">第 ${selected.turn.game} 局 / T${selected.turn.number} / ${Replay.clock(selected.entry.t)}</p><h3>${html(f?.title||'从这一步重新选择')}</h3></div><div class="node-links"><button id="studio-locate" class="text-button">查看原局 ↗</button>${retained?`<a class="text-button" href="${html(retained.downloadUrl)}" download>下载已筛选回放 ↓</a>`:''}</div></div><p class="original-action"><span>原操作</span>${html(f?.observed||selected.entry.text.split('\n')[0])}</p>${f?`<p class="review-analysis">${html(f.analysis)}</p><p class="review-recommendation">${html(f.recommended)}</p><p class="review-confidence">判断置信度：${confidence[f.confidence]}${(f.hiddenInformation||[]).length?' · 涉及隐藏信息':''}</p>`:'<p class="step-description">'+(state.review?'此操作未单独列为关键失误。可以描述新打法，再让 AI 重演。':'请先完成整盘复盘，再根据分析编辑或生成分支。')+'</p>'}${audit?`<details class="mana-audit"><summary>法术力与费用核对</summary><div class="mana-sources">${audit.availableSources.map(s=>`<div><b>${html(s.name)}</b><span>${html(manaOwner(s.cardId))} · ${s.tapped?'已横置':s.amount+' × '+s.colors.join('/')} </span></div>`).join('')}</div><dl><dt>法术力池</dt><dd>${html(audit.availablePool)}</dd><dt>费用</dt><dd>${html(audit.spellCost)}</dd><dt>费用修正</dt><dd>${html(audit.modifiers.join('；')||'无')}</dd><dt>支付顺序</dt><dd>${html(audit.paymentPlan.join(' → '))}</dd><dt>支付后剩余</dt><dd>${html(audit.remainingMana)}</dd></dl>${audit.uncertainties.length?`<p class="audit-uncertainties">待确认：${html(audit.uncertainties.join('；'))}</p>`:''}</details>`:''}${hidden.length?`<details class="hidden-hand-notes"><summary>可能的对手手牌 · 假设</summary>${hidden.map(h=>`<p><b>${html(h.cards.map(c=>(c.count>1?c.count+' × ':'')+c.name).join(' / '))}</b><br>${html(h.basis)}<small>置信度 ${confidence[h.confidence]} · 其他候选：${html(h.alternatives.join(' / '))}</small></p>`).join('')}</details>`:''}<section class="route-section"><h4>你想怎样改变这一步</h4><p class="step-description">描述你希望怎样打，AI 提炼目标，Forge 执行费用、优先权与双方后续。</p><textarea id="studio-intent" rows="4" placeholder="例如：这里不施放 Brainstorm，先施放 Tamiyo, Inquisitive Student，保留 Flame of Anor 应对。">${html(state.edits.get(state.line)||'')}</textarea><div class="intent-actions"><button id="studio-extract" class="import-button">提炼新打法 ↗</button><button id="studio-generate" class="primary">补全并重演 ↗</button></div>${plan?.quality?.keep===false?`<p class="intent-issues">未保留这条路线：${html(plan.quality.reason)}</p>`:''}${plan&&!plan.feasible?`<p class="intent-issues">${html(plan.issues.join('；'))}</p>`:''}<details class="execution-details"${plan?' open':''}><summary>${plan?'AI 提炼的新打法':'实际执行顺序与支付'}</summary><div id="route-editor"></div></details><p class="step-description">可以继续描述修改后重新提炼；重演时会推断隐藏手牌，并补全双方后续。</p></section>`;
    el('review-node').querySelector('.route-section').insertAdjacentHTML('beforebegin','<div id="studio-branch-start" class="studio-branch-start" aria-live="polite"></div>');
    const pressure=state.stressDrafts.get(state.line)||'',intentActions=el('review-node').querySelector('.intent-actions');
    el('studio-generate').textContent='开始搜索 ↗';
    if(!state.review){
      const description=el('review-node').querySelector('.original-action + .step-description');
      if(description)description.textContent=state.deckProfiles?'写下自己的打法，就可以从这一步测试。':'先准备对局，再校验此节点并输入打法。';
    }
    intentActions.insertAdjacentHTML('beforebegin',`<details class="studio-pressure"${pressure?' open':''}><summary>压力世界（可选）</summary><label for="studio-stress-cards">指定对手未知手牌</label><p id="studio-pressure-hint">每行填一张牌的英文名。同一张牌可以填多行。填写后只测试这组压力条件，留空使用默认三组世界。</p><textarea id="studio-stress-cards" rows="3" maxlength="4000" aria-describedby="studio-pressure-hint" spellcheck="false" placeholder="Force of Will&#10;Brainstorm">${html(pressure)}</textarea></details>`);
    intentActions.insertAdjacentHTML('afterend','<p id="studio-node-job" class="node-job-status" role="status" hidden></p>'+pressureComparison(plan?.stressComparison)+searchDetails(plan));
    renderRoute();renderNodeJob();renderBranchStart();controls();checkSelectedBranch();
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
  function acceptPlan(job){
    const plan=job.result?.plan;if(!plan)return;
    state.plans.set(job.sourceLine,{...plan,jobId:job.id,quality:job.result.quality||null,searchSummary:job.result.searchSummary,searchJobId:job.type==='search'?job.id:job.parentJobId});
  }
  async function watch(id,version=state.version){
    clearTimeout(state.poll);
    try{
      const job=await api('/api/jobs/'+id);if(version!==state.version)return;state.job=job;acceptEvidence(job.result||{});renderJob();
      if(job.status==='complete'&&job.type==='prepare'){
        state.branchChecks=new Map();
        if(job.result.preparedAt){state.review=job.result.review;state.reviewPending=false;state.reviewRevision=null;state.sideboardPlans=[];state.plans.clear();state.route=[];}
        renderOverview();renderNodes();renderNode();controls();
        if(!state.line)switchView('report');
      }
      if(job.status==='complete'&&job.type==='shortlist'){
        state.shortlist=job.result.shortlist;renderOverview();renderNodes();
        if(!state.line&&state.shortlist.nodes.length)openNode(state.shortlist.nodes[0].sourceLine,false);
      }
      if(job.type==='review'&&job.status==='complete'&&state.reviewRevision!==job.id+':'+job.result?.reviewRevision)state.branchChecks=new Map();
      if(job.result?.review&&(job.status==='complete'||state.reviewRevision!==job.id+':'+job.result.reviewRevision)){preserveEdits();state.review=job.result.review;state.reviewPending=!!job.result.reviewPending;state.reviewRevision=job.id+':'+job.result.reviewRevision;renderOverview();if(!state.line)state.line=findings().find(f=>f.severity==='mistake')?.sourceLine||findings()[0]?.sourceLine;const f=findings().find(f=>f.sourceLine===state.line);state.route=(state.plans.get(state.line)?.proposedLine||f?.proposedLine||[]).map(s=>({...s}));renderNodes();renderNode();}
      const plan=job.result?.plan;
      if(plan&&(job.status==='complete'||plan.stressComparison&&state.plans.get(job.sourceLine)?.jobId!==job.id)){
        acceptPlan(job);
        if(state.line===job.sourceLine){preserveEdits();state.route=plan.proposedLine;renderNode();}
      }
      if(job.status==='running'){state.poll=setTimeout(()=>watch(id,version),1500);return;}
      if(job.status==='complete'){
        if(job.result.downloadUrl){state.result=job.result;renderResult();el('studio-result').scrollIntoView({block:'nearest'});}
      }
    }catch(error){if(version!==state.version)return;el('studio-job-message').textContent='连接暂时中断，正在重连…';state.poll=setTimeout(()=>watch(id,version),4000);}
  }
  async function submit(type,parentJobId=null){
    const version=state.version;
    const nodeJob=['plan','search','branch'].includes(type),sourceLine=nodeJob||type==='quality'?state.line:null;
    if(nodeJob&&branchStatus(sourceLine)!=='ready')return;
    try{
      preserveEdits();const intent=el('studio-intent')?.value||'';
      state.job={type,sourceLine,status:'running',message:'正在提交任务…'};renderJob();
      const stressCards=sourceLine===null?[]:(state.stressDrafts.get(sourceLine)||'').split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
      const deckPreferences=['review','prepare'].includes(type)?await reviewDeckPreferences():null;
      if(version!==state.version)return;
      const reviewOptions=type==='review'?{aiShortlist:el('review-ai-shortlist').checked,searchMode:el('review-search-mode').value}:undefined;
      const job=await api('/api/jobs',{method:'POST',body:JSON.stringify({type,replayId:state.replayId,sourceLine,parentJobId,focus:intent,deckPreferences,stressCards,reviewOptions,manualSideboard:deckPreferences?manualSideboard():undefined})});
      if(version!==state.version)return;
      state.job=job;renderJob();watch(job.id,version);
    }catch(error){if(version!==state.version)return;state.job={type,sourceLine,status:'failed',message:'提交失败。',error:error.message};renderJob();if(nodeJob&&error.status===409&&state.line===sourceLine)checkSelectedBranch({retry:true});notify(error.message,true);}
  }
  async function onModel(next){
    state.branchChecks=new Map();
    state.stressDrafts=new Map();
    state.shortlist=null;
    for(const side of deckSides){el('studio-deck-mode-'+side).value='local';el('studio-deck-file-'+side).value='';}
    const version=++state.version;clearTimeout(state.poll);state.model=next;state.evidence=[];state.deckProfiles=null;state.sideboardPlans=[];state.replayId=null;state.review=null;state.line=null;state.route=[];state.edits.clear();state.plans.clear();state.job=null;state.result=null;state.reviewPending=false;state.reviewRevision=null;renderOverview();renderNodes();renderResult();renderJob();
    renderManualSideboard();
    el('review-node').innerHTML='<div class="review-placeholder"><h3>选择一个分支节点</h3><p>准备对局后，可到中文战报选操作，再输入你想测试的打法。</p></div>';
    if(!state.ready)return;
    try{const registered=await api('/api/replays',{method:'POST',body:JSON.stringify({filename:next.filename||'replay.esreplay',jsonl:next.sourceText})});if(version!==state.version)return;state.replayId=registered.id;try{state.edits=new Map(JSON.parse(sessionStorage.getItem('endstep-intents:'+state.replayId)||'[]'));state.stressDrafts=new Map(JSON.parse(sessionStorage.getItem('endstep-pressure:'+state.replayId)||'[]'));}catch{}state.review=registered.review;acceptEvidence(registered);renderManualSideboard(registered.deckProfiles?.manualSideboard);renderOverview();renderNodes();controls();switchView('codex');if(findings().length)openNode(findings()[0].sourceLine,false);}catch(error){notify('后端导入失败：'+error.message,true);}
  }
  el('studio-review').onclick=()=>submit('review');
  el('studio-prepare').onclick=()=>submit('prepare');
  el('studio-shortlist').onclick=()=>submit('shortlist');
  el('studio-apply-sideboard').onclick=()=>submit('prepare');
  el('studio-sideboard-games').onchange=event=>{
    if(event.target.type==='checkbox')event.target.closest('[data-sideboard-game]').querySelector('.sideboard-cards').hidden=!event.target.checked;
  };
  el('review-search-mode').onchange=()=>{
    const deep=el('review-search-mode').value==='deep';
    el('review-search-note').textContent=(deep?'暴力大算搜索全部可恢复节点。每节点三个世界，每世界最多 120 次迭代，可能运行很久，可随时取消。':'标准最多搜索 8 个成功恢复的节点。')+'关闭初筛后按原局顺序取样，优先覆盖每局。胜局二筛和最终解读仍使用 AI。';
  };
  el('studio-deck-sources').addEventListener('change',controls);
  el('studio-cancel').onclick=async()=>{if(state.job)try{await api('/api/jobs/'+state.job.id,{method:'DELETE'});}catch(e){notify(e.message,true);}};
  el('review-nodes').onclick=e=>{const b=e.target.closest('[data-review-line]');if(b)openNode(Number(b.dataset.reviewLine));};
  el('review-node').addEventListener('input',e=>{if(['studio-intent','studio-stress-cards'].includes(e.target.id)){preserveEdits();controls();}});
  el('review-node').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.id==='studio-locate')locate();
    if(b.id==='studio-generate')submit('search');
    if(b.id==='studio-screen-search')submit('quality',b.dataset.job);
    if(b.id==='studio-extract')submit('plan');
    if(b.id==='studio-earlier-branch')openNode(Number(b.dataset.line));
    if(b.id==='studio-retry-branch-check')checkSelectedBranch({retry:true});
  });
  globalThis.Studio={onModel:next=>(state.modelTask=onModel(next)),openNode,branchStatus,state};
  async function boot(){
    if(!['http:','https:'].includes(location.protocol)){el('codex-connection').textContent='需启动本地后端';el('manual-workflow').hidden=false;el('studio-review').disabled=true;el('studio-job').hidden=false;el('studio-job-message').textContent='请运行 start.ps1 启动应用；双击 HTML 不能调用 Codex。';el('studio-cancel').hidden=true;return;}
    try{
      const health=await api('/api/health');state.ready=health.connected;state.loggedIn=health.loggedIn;state.forgeInstalled=!!health.forge?.installed;el('codex-connection').textContent=health.connected?(health.loggedIn?'Codex 已连接':'Codex 尚未登录'):'Codex 连接失败';el('codex-connection').classList.toggle('connected',state.ready&&state.loggedIn);el('studio-model').textContent=health.model?'模型：'+health.model+' · 推理：'+(health.reasoningEffort||'默认'):'模型：沿用本机 Codex 配置';el('studio-model').textContent+=' · '+(state.forgeInstalled?(health.forge.engine||'Forge').replace(/^forge-/,'Forge '):'Forge 未安装，请运行安装Forge.cmd');controls();
      const current=await api('/api/current');
      if(!current){if(model)await onModel(model);return;}
      loadModel(Replay.parse(current.jsonl,current.filename));
      await state.modelTask;
      acceptEvidence(current);
      const ordered=current.jobs.sort((a,b)=>a.createdAt-b.createdAt);
      state.shortlist=ordered.findLast(j=>j.type==='shortlist'&&j.status==='complete')?.result.shortlist||null;
      const prepared=ordered.findLast(j=>j.type==='prepare'&&j.status==='complete'&&j.result?.preparedAt);
      for(const job of ordered)if(job.status==='complete'&&job.createdAt>=(prepared?.createdAt||0))acceptPlan(job);
      renderOverview();renderNodes();controls();
      const recent=ordered.findLast(j=>j.status==='running')||ordered.findLast(j=>j.status==='complete'||j.errorCode?.startsWith('deck_')||j.status==='failed'&&j.type!=='review');
      if(recent?.sourceLine&&entryAt(recent.sourceLine)){
        state.edits.set(recent.sourceLine,state.edits.get(recent.sourceLine)||recent.intent||'');
        if(recent.stressCards?.length&&!state.stressDrafts.has(recent.sourceLine)){
          const draft=recent.stressCards.join('\n');state.stressDrafts.set(recent.sourceLine,draft);
          if(state.line===recent.sourceLine&&el('studio-stress-cards'))el('studio-stress-cards').value=draft;
        }
        openNode(recent.sourceLine,false);
      }
      if(recent)watch(recent.id);
    }catch(error){state.ready=false;el('codex-connection').textContent='后端未连接';el('studio-job').hidden=false;el('studio-job-message').textContent=error.message;el('studio-cancel').hidden=true;controls();}
  }
  boot();
})();
