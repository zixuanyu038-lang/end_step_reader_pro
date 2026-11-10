'use strict';
const fs=require('node:fs'),path=require('node:path');
function compare(a,b){
  if(a.value!==b.value)return a.value-b.value;
  if(a.value===1)return b.turn-a.turn;
  if(a.value===-1)return a.turn-b.turn;
  return 0;
}
function backup(run,viewer){
  const tests=new Map();
  for(const sim of run.simulations){
    if(!sim.terminal)continue;
    const value=sim.winnerId==null?0:String(sim.winnerId)===viewer?1:-1;
    tests.set(JSON.stringify(sim.path.map(a=>a.key)),{value,turn:sim.turn,path:sim.path});
  }
  function visit(node,prefix){
    const children=node.children.map(c=>visit(c,prefix.concat(c.action.key))).filter(Boolean);
    if(!children.length)return tests.get(JSON.stringify(prefix))||null;
    const own=String(node.actorId)===viewer;
    return children.reduce((best,child)=>(own?compare(child,best)>0:compare(child,best)<0)?child:best);
  }
  return run.tree.children.map(child=>({action:child.action,outcome:visit(child,[child.action.key])}));
}
function summarize(result,viewer){
  const roots=new Map();
  for(const run of result.search.runs)for(const line of backup(run,viewer)){
    const item=roots.get(line.action.key)||{action:line.action,worlds:[]};
    item.worlds.push({id:run.worldId,...line.outcome});roots.set(line.action.key,item);
  }
  return [...roots.values()].map(r=>{
    const won=r.worlds.filter(w=>w.value===1);
    return {...r,win:won.length,loss:r.worlds.filter(w=>w.value===-1).length,
      draw:r.worlds.filter(w=>w.value===0).length,unknown:result.search.runs.length-r.worlds.filter(w=>w.value!=null).length,
      winTurn:won.length?won.reduce((n,w)=>n+w.turn,0)/won.length:null};
  }).sort((a,b)=>Number(a.unknown>0)-Number(b.unknown>0)||b.win-a.win||a.loss-b.loss||
    (a.winTurn??Infinity)-(b.winTurn??Infinity));
}
if(require.main===module){
  const dir=process.argv[2],viewer=String(process.argv[3]??0);
  if(!dir)throw Error('Pass the full game audit output directory.');
  const results=fs.readdirSync(dir).filter(f=>/^adversarial-\d+\.json$/.test(f)).map(f=>{
    const r=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
    const {search,...stats}=r;
    return {...stats,ranking:search?summarize(r,viewer):[]};
  });
  fs.writeFileSync(path.join(dir,'adversarial-ranking.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(r=>({line:r.line,card:r.card,publicHand:r.publicHand,opponentReplies:r.opponentReplies,
    solitudeReplies:r.solitudeReplies,effectChoices:r.effectChoices,error:r.error,top:r.ranking.slice(0,3).map(a=>({label:a.action.label,win:a.win,loss:a.loss,unknown:a.unknown,winTurn:a.winTurn}))}))));
}
module.exports={summarize,backup};
