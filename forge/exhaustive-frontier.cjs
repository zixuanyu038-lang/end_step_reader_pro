'use strict';
const {DatabaseSync}=require('node:sqlite');
const {compact}=require('../tree-search');

// Pending rows stay pending during an engine request. Only a transaction can
// finish a row, and it must persist every child in the same transaction.
async function enumerateFrontier({file,roots,workers,focusLines=[],viewer,expand,signal,guide,onGuide=()=>{},onProgress=()=>{}}){
  const db=new DatabaseSync(file);
  try{
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS roots (
        id INTEGER PRIMARY KEY, world TEXT NOT NULL UNIQUE, definition TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY, root INTEGER NOT NULL, parent INTEGER,
        depth INTEGER NOT NULL, action TEXT, status TEXT NOT NULL DEFAULT 'pending',
        detail TEXT, UNIQUE(parent, action)
      );
      CREATE INDEX IF NOT EXISTS pending_branches ON branches(depth,id) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS pending_roots ON branches(root,depth,id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS proofs (
        branch INTEGER PRIMARY KEY, value INTEGER NOT NULL, turn INTEGER NOT NULL, witness INTEGER
      );
    `);
    const transaction=fn=>{
      db.exec('BEGIN IMMEDIATE');
      try{const value=fn();db.exec('COMMIT');return value;}
      catch(error){db.exec('ROLLBACK');throw error;}
    };
    const rootById=new Map();
    const rootSelect=db.prepare('SELECT * FROM roots WHERE world=?');
    const addRoot=db.prepare('INSERT INTO roots(world,definition) VALUES(?,?)');
    const enqueue=db.prepare('INSERT INTO branches(root,parent,depth,action) VALUES(?,?,?,?)');
    transaction(()=>{
      for(const root of roots){
        const definition=JSON.stringify({line:root.line,root:root.world.root,prefix:root.prefix||[]});
        const key=root.line+':'+root.world.id;
        const saved=rootSelect.get(key);
        if(saved&&saved.definition!==definition)throw Error('Exhaustive search root changed: '+key);
        const id=saved?.id??Number(addRoot.run(key,definition).lastInsertRowid);
        if(!saved)enqueue.run(id,null,0,null);
        rootById.set(id,root);
      }
      if(db.prepare('SELECT count(*) AS n FROM roots').get().n!==rootById.size)throw Error('Resume with the same replay roots.');
    });
    const pending=db.prepare("SELECT id,root,depth FROM branches WHERE status='pending' AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY depth,id LIMIT 1");
    const focused=db.prepare("SELECT id,root,depth FROM branches WHERE status='pending' AND root IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY depth,id LIMIT 1");
    const rootGroups=focusLines.map(line=>JSON.stringify([...rootById].filter(([,root])=>root.line===line).map(([id])=>id)));
    const rootBranch=db.prepare('SELECT id,root,depth,status FROM branches WHERE root=? AND parent IS NULL');
    const childBranch=db.prepare('SELECT id,root,depth,status FROM branches WHERE parent=? AND action=?');
    const descendant=db.prepare(`
      WITH RECURSIVE subtree(id,root,depth,status) AS (
        SELECT id,root,depth,status FROM branches WHERE parent=? AND status IN ('pending','expanded')
        UNION ALL
        SELECT b.id,b.root,b.depth,b.status FROM branches b JOIN subtree s ON b.parent=s.id
          WHERE b.status IN ('pending','expanded')
      ) SELECT id,root,depth FROM subtree WHERE status='pending'
        AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY depth,id LIMIT 1
    `);
    const ancestors=db.prepare(`
      WITH RECURSIVE path(id,parent,depth,action) AS (
        SELECT id,parent,depth,action FROM branches WHERE id=?
        UNION ALL
        SELECT b.id,b.parent,b.depth,b.action FROM branches b JOIN path p ON b.id=p.parent
      ) SELECT action FROM path WHERE action IS NOT NULL ORDER BY depth
    `);
    const update=db.prepare("UPDATE branches SET status=?,detail=? WHERE id=? AND status='pending'");
    const branchInfo=db.prepare('SELECT id,parent,depth,status,detail FROM branches WHERE id=?');
    const childProofs=db.prepare('SELECT branches.id,proofs.value,proofs.turn FROM branches LEFT JOIN proofs ON proofs.branch=branches.id WHERE parent=?');
    const saveProof=db.prepare('INSERT OR IGNORE INTO proofs(branch,value,turn,witness) VALUES(?,?,?,?)');
    const cover=db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM branches WHERE parent=? AND id!=?
        UNION ALL SELECT b.id FROM branches b JOIN descendants d ON b.parent=d.id
      ) UPDATE branches SET status='covered' WHERE status='pending' AND id IN (SELECT id FROM descendants)
    `);
    function proveTerminal(branchId,{winner,turn}){
      const value=winner==null?0:String(winner)===String(viewer)?1:-1;
      if(!Number.isInteger(turn)||!saveProof.run(branchId,value,turn,null).changes)return;
      let parent=branchInfo.get(branchId).parent;
      while(parent!==null){
        const node=branchInfo.get(parent),detail=JSON.parse(node.detail);
        if(node.status!=='expanded'||detail?.actor==null||detail.gaps?.length)break;
        const direction=String(detail.actor)===String(viewer)?1:-1;
        const children=childProofs.all(parent);
        // At the replay root we still compare every opening action.
        const decisive=node.depth>0&&children.find(c=>c.value===direction&&c.turn===detail.turn);
        if(!decisive&&children.some(c=>c.value===null))break;
        const best=decisive||children.reduce((a,b)=>{
          const preference=b.value-a.value||b.value*(a.turn-b.turn);
          return direction*preference>0?b:a;
        });
        if(!saveProof.run(parent,best.value,best.turn,best.id).changes)break;
        if(decisive)cover.run(parent,best.id);
        parent=node.parent;
      }
    }
    if(viewer!=null){
      const prior=db.prepare("SELECT id,detail FROM branches WHERE status='terminal' AND id NOT IN (SELECT branch FROM proofs)").all();
      transaction(()=>{for(const branch of prior)proveTerminal(branch.id,JSON.parse(branch.detail));});
    }
    const counts=()=>Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM branches GROUP BY status').all().map(r=>[r.status,r.n]));
    const inflight=new Set(),waiting=[];
    let fatal,processed=0,guideTurn=0;
    const wake=()=>waiting.splice(0).forEach(resolve=>resolve());
    function ordered(index){
      const reserved=JSON.stringify([...inflight]);
      return (rootGroups[index]&&focused.get(rootGroups[index],reserved))||pending.get(reserved);
    }
    function follow(hint){
      const root=rootSelect.get(hint.line+':'+hint.world);
      if(!root)return;
      let row=rootBranch.get(root.id);
      for(const action of hint.path){
        if(row?.status!=='expanded')break;
        row=childBranch.get(row.id,JSON.stringify(compact(action)));
      }
      if(row?.status==='pending'&&!inflight.has(row.id))return row;
      if(row?.status==='expanded')return descendant.get(row.id,JSON.stringify([...inflight]));
    }
    async function run(worker,index){
      let walk,nextStep,walkSteps=0;
      while(!signal?.aborted&&!fatal){
        let branch=nextStep&&branchInfo.get(nextStep.id)?.status==='pending'&&!inflight.has(nextStep.id)?nextStep:null;
        if(!branch){walk=null;nextStep=null;branch=ordered(index);}
        if(branch&&!walk&&index===0&&guide&&guideTurn++%8===0){
          let hint,preferred,error;
          try{hint=await guide(worker,signal);preferred=hint&&follow(hint);}
          catch(failure){error=failure.message;}
          if(signal?.aborted||fatal)return;
          try{onGuide({hint,preferred,error});}
          catch(failure){fatal??=failure;wake();return;}
          branch=preferred||ordered(index);
          if(preferred&&hint.walk){walk=hint.walk;walkSteps=0;}
        }
        if(!branch){
          if(!inflight.size)return;
          await new Promise(resolve=>waiting.push(resolve));
          continue;
        }
        inflight.add(branch.id);
        try{
          const root=rootById.get(branch.root);
          const path=[...(root.prefix||[]),...ancestors.all(branch.id).map(row=>JSON.parse(row.action))];
          let response,error;
          try{response=await expand(worker,root,path,signal);}
          catch(failure){if(signal?.aborted)return;error=failure.message;}
          if(signal?.aborted)return;
          const actions=response?.stopReason==='decision'?[...new Map(response.actions.map(a=>[a.key,compact(a)])).values()]:[];
          const status=response?.stopReason==='game_over'?'terminal':actions.length?'expanded':'blocked';
          const detail={stop:response?.stopReason,turn:response?.state?.turnNumber,phase:response?.state?.phase,
            actor:response?.state?.priorityPlayerId,winner:response?.state?.winnerId??null,actions:actions.length,
            gaps:response?.enumerationGaps,error};
          const saved=transaction(()=>{
            if(!update.run(status,JSON.stringify(detail),branch.id).changes)return false;
            for(const action of actions)enqueue.run(branch.root,branch.id,branch.depth+1,JSON.stringify(action));
            if(status==='terminal'&&viewer!=null)proveTerminal(branch.id,detail);
            return true;
          });
          if(saved)onProgress({processed:++processed,line:root.line,world:root.world.id,id:branch.id,depth:branch.depth,status,detail,path,actions,counts,guided:!!walk});
          nextStep=null;
          if(saved&&walk){
            if(status==='terminal')walk.terminal(detail.winner);
            // Yield the worker after a run of guided expansions. The whole path and its siblings are already on disk.
            if(status==='expanded'&&++walkSteps<32){
              const action=walk.next(response.state,actions,path);
              nextStep=childBranch.get(branch.id,JSON.stringify(compact(action)));
            }
          }
        }catch(error){fatal??=error;}
        finally{inflight.delete(branch.id);wake();}
      }
    }
    await Promise.all(workers.map(run));
    if(fatal)throw fatal;
    return counts();
  }finally{db.close();}
}

module.exports={enumerateFrontier};
