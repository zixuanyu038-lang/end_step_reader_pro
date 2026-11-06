'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{CodexClient}=require('../codex-client');
function run(client,id){let value,error,progress;client.turns.set(id,{text:'',messages:[],resolve:x=>{value=x;},reject:e=>{error=e;},onProgress:x=>{progress=x;}});return{get value(){return value;},get error(){return error;},get progress(){return progress;}};}
test('Codex transport assembles only the final structured message and ignores other threads',()=>{
 const c=new CodexClient(),r=run(c,'one');
 c.receive({method:'item/agentMessage/delta',params:{threadId:'other',delta:'unrelated'}});
 c.receive({method:'item/completed',params:{threadId:'one',item:{type:'agentMessage',text:'intermediate commentary'}}});
 c.receive({method:'item/completed',params:{threadId:'one',item:{type:'agentMessage',text:'{"ok":true}'}}});
 c.receive({method:'turn/completed',params:{threadId:'one',turn:{status:'completed'}}});assert.deepEqual(r.value,{ok:true});assert.equal(r.error,undefined);assert.equal(c.turns.size,0);
});
test('reconnecting is reported; fatal runtime errors and malformed final JSON fail rather than hanging',()=>{
 const c=new CodexClient(),r=run(c,'one');c.receive({method:'error',params:{threadId:'one',willRetry:true,error:{message:'Reconnecting...'}}});assert.equal(r.progress.phase,'reconnecting');assert.equal(c.turns.size,1);
 c.receive({method:'error',params:{threadId:'one',willRetry:false,error:{message:'Incorrect key sk-exampleSecretValue'}}});assert.match(r.error.message,/\[redacted\]/);assert.ok(!r.error.message.includes('sk-example'));assert.equal(c.turns.size,0);
 const invalid=run(c,'two');c.receive({method:'item/completed',params:{threadId:'two',item:{type:'agentMessage',text:'not JSON'}}});c.receive({method:'turn/completed',params:{threadId:'two',turn:{status:'completed'}}});assert.match(invalid.error.message,/JSON/);
});
