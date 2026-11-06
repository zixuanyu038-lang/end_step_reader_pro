'use strict';
const crypto=require('node:crypto');
const {auditRoot}=require('./hidden-worlds');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const compact=a=>({key:a.key,kind:a.kind,actorId:a.actorId,label:a.label});
function deduplicate(actions){
  const seen=new Set();return actions.filter(a=>{
    const key=a.kind==='pass'?a.key:JSON.stringify([a.actorId,a.kind,a.cardName,a.abilityIndex,a.modes,a.targets,a.x,a.manaCost]);
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
function rankActions(actions,state,{observedCardId=null,width=8}={}){
  const ownCards=new Map(state.players.flatMap(p=>['hand','battlefield','graveyard','exile'].flatMap(z=>p[z]||[]).map(c=>[String(c.id),c])));
  const priority=a=>{
    let score=a.kind==='pass'?70:a.kind==='play_land'?80:50;
    if(String(a.cardId)===String(observedCardId))score+=100;
    if(a.kind==='activate'&&/Strand|Tarn|Delta|Mesa|Vista|Mire|Heath|Rainforest|Catacombs|Foothills|Flats/.test(a.cardName))score+=20;
    for(const ref of (a.targets||[]).flat())if(ref.startsWith('c:')){
      const target=ownCards.get(ref.slice(2));
      if(target&&String(target.controllerId)===String(a.actorId)&&/Plowshares|Bolt|Flame of Anor|Prismatic Ending/.test(a.cardName))score-=150;
    }
    if(a.cardName==='Flame of Anor'&&(a.modeDescriptions||[]).some(s=>/draw/i.test(s))&&(a.targets||[]).flat().includes('p:'+(1-a.actorId)))score-=200;
    return score;
  };
  const ranked=deduplicate(actions).sort((a,b)=>priority(b)-priority(a)||a.key.localeCompare(b.key));
  const kept=ranked.slice(0,width),pass=ranked.find(a=>a.kind==='pass');
  if(pass&&!kept.includes(pass)){kept.pop();kept.push(pass);}return kept;
}
function originalSelection(source,actions){
  const row=source.rows.find(x=>x.line===source.anchor.line)?.row;
  const id=row?.action?.cardId;if(id==null)return{matched:false,reason:'这个节点没有精确的原施法操作。'};
  const targets=[];let modeCount=null;
  for(const x of source.rows){
    if(x.line<=source.anchor.line)continue;
    const r=x.row;if(r.k==='action'&&r.action.type==='PLAY_CARD')break;
    if(r.k==='action'&&r.action.type==='CHOOSE_MODE')modeCount=r.action.orderedCards?.length??null;
    if(r.k==='action'&&r.action.type==='CHOOSE_TARGETS')for(const target of r.action.targets||[]){
      if(target===-1||target===-2)targets.push('p:'+(-target-1));
      else if(target<0){const onStack=source.baseline.stack.find(s=>s.stackTargetId===target);if(onStack)targets.push('s:'+onStack.sourceCard.id);}
      else targets.push('c:'+target);
    }
    if(r.k==='event'&&r.event.type==='SPELL_RESOLVED'&&String(r.event.cardId)===String(id))break;
  }
  let matches=actions.filter(a=>String(a.cardId)===String(id));
  if(modeCount!=null)matches=matches.filter(a=>a.modes?.length===modeCount);
  if(targets.length)matches=matches.filter(a=>JSON.stringify((a.targets||[]).flat().slice().sort())===JSON.stringify(targets.slice().sort()));
  if(matches.length!==1)return{matched:false,cardId:id,reason:'未能唯一恢复原操作的模式、目标或可支付费用；不据此判定失误。'};
  return{matched:true,key:matches[0].key,action:matches[0]};
}
class Node {
  constructor({path=[],action=null,parent=null,state=null,actions=[]}={}){Object.assign(this,{path,action,parent,state,actions});this.children=[];this.visits=0;this.total=0;this.reward=0;this.rejected=[];}
}
async function search({client,source,worlds,signal,budget={},onProgress=()=>{}}){
  const settings={iterations:32,maxDepth:7,width:7,horizonTurns:100,maxChoices:2000,maxSteps:4000,...budget};
  settings.iterations=Math.max(8,Math.min(120,settings.iterations));settings.width=Math.max(2,Math.min(12,settings.width));settings.maxDepth=Math.max(1,Math.min(16,settings.maxDepth));
  const rootActor=Number(source.baseline.priorityPlayerId),viewer=Number(source.header.seat),runs=[],totals=new Map(),rootAudits=[];
  let simulated=0,expanded=0;const winningCandidates=[],winningKeys=new Set();
  for(const [worldIndex,world] of worlds.entries()){
    if(signal?.aborted)throw Error('任务已取消。');
    const cache=new Map();
    const request=async(command,path,includeTrace=false)=>{
      const key=digest({command,path,includeTrace});if(cache.has(key))return cache.get(key);
      const result=await client.request({command,root:world.root,path:path.map(compact),includeTrace,horizonTurns:settings.horizonTurns,maxChoices:settings.maxChoices,maxSteps:settings.maxSteps},{signal});
      if(command==='simulate'&&!includeTrace)simulated++;
      cache.set(key,result);return result;
    };
    const initial=await request('expand',[]);rootAudits.push(auditRoot(source,initial.state));
    for(const [i,p] of source.baseline.players.entries()){
      const top=source.knownTop?.[String(p.id)]||[];
      if(top.some((id,n)=>String(initial.rootLibraries[i][n]?.id)!==String(id)))throw Error('Forge 牌库顶顺序与已知信息不一致。');
    }
    const original=originalSelection(source,initial.actions);
    const root=new Node({state:initial.state,actions:rankActions(initial.actions,initial.state,{observedCardId:original.action?.cardId,width:settings.width})});
    if(original.matched&&!root.actions.some(a=>a.key===original.key)){root.actions.pop();root.actions.push(original.action);}
    const perWorld=[];
    for(let iteration=0;iteration<settings.iterations;iteration++){
      if(signal?.aborted)throw Error('任务已取消。');
      let node=root;const visited=[root];
      while(node.path.length<settings.maxDepth&&node.actions.length){
        const unexplored=node.actions.find(a=>!node.children.some(c=>c.action.key===a.key)&&!node.rejected.includes(a.key));
        if(unexplored){
          const nextPath=node.path.concat(unexplored);
          try{
            const result=await request('expand',nextPath);expanded++;
            const child=new Node({path:nextPath,action:unexplored,parent:node,state:result.state,actions:rankActions(result.actions,result.state,{width:settings.width})});
            node.children.push(child);node=child;visited.push(node);break;
          }catch(error){if(signal?.aborted)throw error;node.rejected.push(unexplored.key);continue;}
        }
        if(!node.children.length)break;
        const actor=Number(node.state.priorityPlayerId),direction=actor===viewer?1:-1;
        node=node.children.reduce((best,c)=>{
          const ucb=x=>x.visits?direction*x.reward/x.visits+Math.sqrt(2*Math.log(Math.max(2,x.parent.visits))/x.visits):Infinity;
          return !best||ucb(c)>ucb(best)?c:best;
        },null);visited.push(node);
      }
      try{
        const result=await request('simulate',node.path);
        const score=result.evaluation.score,terminal=result.stopReason==='game_over'&&result.state.status==='COMPLETE',win=terminal&&String(result.state.winnerId)===String(viewer),loss=terminal&&result.state.winnerId!=null&&!win,reward=win?1:loss?-1:terminal?0:Math.max(-.25,Math.min(.25,score/4000));
        for(const ancestor of visited){ancestor.visits++;ancestor.total+=score;ancestor.reward+=reward;}
        const simulation={path:node.path.map(compact),score,reward,stopReason:result.stopReason,turn:result.state.turnNumber,winnerId:result.state.winnerId??null,terminal};perWorld.push(simulation);
        const winningKey=digest({worldId:world.id,path:simulation.path});if(win&&!winningKeys.has(winningKey)&&!(result.intentStatus?.blocked||[]).length&&(!result.intentStatus||result.intentStatus.completed===result.intentStatus.total)){winningKeys.add(winningKey);winningCandidates.push({id:world.id.slice(0,12)+'-'+iteration,worldId:world.id,...simulation,executed:result.executed||[],features:result.evaluation.features});}
      }catch(error){
        if(signal?.aborted)throw error;
        if(node.parent){node.parent.rejected.push(node.action.key);node.parent.children=node.parent.children.filter(n=>n!==node);}
        perWorld.push({path:node.path.map(compact),error:error.message});
      }
      onProgress({world:worldIndex+1,worlds:worlds.length,iteration:iteration+1,iterations:settings.iterations,simulated,expanded});
    }
    for(const child of root.children){if(!child.visits)continue;
      const key=child.action.key;let aggregate=totals.get(key);if(!aggregate){aggregate={action:child.action,worlds:[],visits:0};totals.set(key,aggregate);}
      aggregate.worlds.push({worldId:world.id,worldIndex,seed:world.root.seed,mean:child.total/child.visits,visits:child.visits});aggregate.visits+=child.visits;
    }
    const serialize=n=>({action:n.action?compact(n.action):null,actorId:Number(n.state.priorityPlayerId),visits:n.visits,mean:n.visits?n.total/n.visits:null,rejected:n.rejected,children:n.children.map(serialize)});
    runs.push({worldId:world.id,seed:world.root.seed,original,tree:serialize(root),simulations:perWorld});
  }
  const alternatives=[...totals.values()].map(a=>{
    const mean=a.worlds.reduce((n,w)=>n+w.mean,0)/a.worlds.length;
    return{...a,mean,min:Math.min(...a.worlds.map(w=>w.mean)),max:Math.max(...a.worlds.map(w=>w.mean)),worldCoverage:a.worlds.length/worlds.length};
  }).filter(a=>a.worldCoverage===1).sort((a,b)=>rootActor===viewer?b.mean-a.mean:a.mean-b.mean);
  if(!alternatives.length)throw Error('没有在所有固定隐藏世界中完成比较的候选路线。');
  const best=alternatives[0],originalKey=runs[0]?.original?.key,original=alternatives.find(a=>a.action.key===originalKey)||null;
  const representativeIndex=best.worlds.reduce((a,b)=>b.mean<a.mean?b:a).worldIndex;
  const representativeWorld=worlds[representativeIndex];
  // Principal variation follows the searched opponent's strongest response, not the luckiest rollout.
  const chosenPath=[best.action];let principal=runs[representativeIndex].tree.children.find(n=>n.action.key===best.action.key);
  while(principal?.children?.some(n=>n.visits>0)){
    const children=principal.children.filter(n=>n.visits>0),maximize=principal.actorId===viewer;
    principal=children.reduce((a,b)=>maximize?(b.mean>a.mean?b:a):(b.mean<a.mean?b:a));chosenPath.push(principal.action);
  }
  const representative=await client.request({command:'simulate',root:representativeWorld.root,path:chosenPath.map(compact),includeTrace:false,horizonTurns:2,maxChoices:settings.maxChoices,maxSteps:settings.maxSteps},{signal});
  const comparison=original?{matched:true,meanDifference:best.mean-original.mean,perWorldDifferences:best.worlds.map(w=>({worldIndex:w.worldIndex,difference:w.mean-original.worlds.find(o=>o.worldIndex===w.worldIndex).mean}))}:{matched:false,reason:runs[0]?.original?.reason||'原操作没有完成同预算比较。'};
  return{format:'forge-search-evidence',version:1,engine:'forge-2.0.15',algorithm:'bounded adversarial UCT over replayed engine paths; independent fixed hidden worlds',settings,simulated,expanded,rootAudits,alternatives,best,original,comparison,runs,
    winningCandidates,representative:{worldId:representativeWorld.id,scenario:representativeWorld.scenario,path:chosenPath.map(compact),...representative},
    limitations:['启发式材料评分不是胜率','情景集可能包含明确构造的交互压力测试，均值不代表真实概率','有限候选、深度、世界及预算，不能证明最优','法术力支付、战斗与部分选择由 Forge 内置策略决定','各隐藏世界分别搜索，尚未实现完整信息集搜索；深层策略可能存在 determinization bias','代表轨迹只是一个已固定假设世界中的真实引擎后续']};
}
module.exports={search,rankActions,deduplicate,originalSelection,compact};
