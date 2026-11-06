'use strict';
function createModelQueue(limit=2){
  const queue=[];let active=0;
  function drain(){while(active<limit&&queue.length){const task=queue.shift();task.signal?.removeEventListener('abort',task.abort);if(task.signal?.aborted){task.reject(Error('任务已取消。'));continue;}active++;Promise.resolve().then(task.fn).then(task.resolve,task.reject).finally(()=>{active--;drain();});}}
  return(fn,signal)=>new Promise((resolve,reject)=>{const task={fn,signal,resolve,reject};task.abort=()=>{const index=queue.indexOf(task);if(index>=0){queue.splice(index,1);reject(Error('任务已取消。'));}};if(signal?.aborted){reject(Error('任务已取消。'));return;}signal?.addEventListener('abort',task.abort,{once:true});queue.push(task);drain();});
}
module.exports={createModelQueue};
