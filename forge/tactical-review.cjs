'use strict';
const {compact}=require('../tree-search');

const label=action=>action.label||action.key;
const terminal=(run,viewer)=>run.stopReason==='game_over'?
  {value:run.state.winnerId==null?0:String(run.state.winnerId)===String(viewer)?1:-1,turn:run.state.turnNumber}:null;
const compare=(a,b)=>a.value-b.value||a.value*(b.turn-a.turn);
const legal=actions=>[...new Map(actions.map(a=>[a.key,a])).values()];
const sameTurn=(a,b)=>Number(a)===Number(b);

// At a tested fork, enumerate every exposed opponent action, followed by
// every immediate legal recovery when the native continuation loses.
async function challengeFork({path,fork,viewer,request,suffix}){
  const replies=[];
  for(const reply of legal(fork.actions)){
    const replyPath=path.concat(compact(reply)),recoveries=[];
    try{
      const outcome=terminal(await request('simulate',replyPath),viewer);
      let best=outcome,routeProbe;
      if(suffix?.length){
        const continued=replyPath.concat(suffix);
        try{
          const result=terminal(await request('simulate',continued),viewer);
          routeProbe={result};
          if(result&&(!best||compare(result,best)>0)){best=result;routeProbe.bestPath=continued;}
        }catch(error){routeProbe={interrupted:error.message};}
      }
      if(best?.value!==1){
        const own=await request('expand',replyPath);
        if(own.stopReason==='decision'&&sameTurn(own.state.turnNumber,fork.state.turnNumber)&&String(own.state.priorityPlayerId)===String(viewer)){
          for(const action of legal(own.actions)){
            try{
              const result=terminal(await request('simulate',replyPath.concat(compact(action))),viewer);
              recoveries.push({action:compact(action),result});
              if(result&&(!best||compare(result,best)>0))best=result;
            }catch(error){recoveries.push({action:compact(action),error:error.message});}
          }
        }
      }
      replies.push({action:compact(reply),outcome,best,recoveries,routeProbe});
    }catch(error){replies.push({action:compact(reply),recoveries,error:error.message});}
  }
  return {path,turn:fork.state.turnNumber,phase:fork.state.phase,gaps:fork.enumerationGaps||[],replies};
}

async function checkTacticalArm({path,scope,viewer,turn,request}){
  const route=path.map(compact),forks=[],errors=[];
  let native=null;
  try{native=terminal(await request('simulate',route),viewer);}
  catch(error){errors.push(error.message);}
  if(scope==='route'){
    for(let i=0;i<=route.length;i++){
      const prefix=route.slice(0,i);
      try{
        const fork=await request('expand',prefix);
        if(fork.stopReason==='decision'&&sameTurn(fork.state.turnNumber,turn)&&String(fork.state.priorityPlayerId)!==String(viewer))
          forks.push(await challengeFork({path:prefix,fork,viewer,request,suffix:route.slice(i+1)}));
      }catch(error){errors.push(error.message);}
    }
  }else{
    let prefix=route;
    try{
      let fork=await request('expand',prefix);
      if(fork.stopReason==='decision'&&String(fork.state.priorityPlayerId)===String(viewer)){
        const pass=fork.actions.find(a=>a.kind==='pass');
        if(pass){prefix=prefix.concat(compact(pass));fork=await request('expand',prefix);}
      }
      if(fork.stopReason==='decision'&&sameTurn(fork.state.turnNumber,turn)&&String(fork.state.priorityPlayerId)!==String(viewer))
        forks.push(await challengeFork({path:prefix,fork,viewer,request}));
    }catch(error){errors.push(error.message);}
  }
  const challenged=forks.flatMap(f=>f.replies);
  const partial=errors.length>0||forks.some(f=>f.gaps.length)||challenged.some(r=>!r.best||r.recoveries.some(x=>!x.result));
  const known=challenged.map(r=>r.best).filter(Boolean);
  const worst=known.length?known.reduce((a,b)=>compare(a,b)<0?a:b):null;
  return {native,worst,forks,errors,partial};
}

module.exports={checkTacticalArm};
