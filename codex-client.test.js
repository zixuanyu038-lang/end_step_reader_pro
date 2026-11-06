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
test('retry reasons remain distinct and reasoning/tool activity clears a stale retry banner',()=>{
 const c=new CodexClient(),r=run(c,'one'),diagnostics=[];c.turns.get('one').onDiagnostic=e=>diagnostics.push(e);
 c.receive({method:'error',params:{threadId:'one',willRetry:true,error:{message:'Service failed',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}},additionalDetails:'Bearer private-secret'}}});
 assert.equal(r.progress.phase,'retrying');assert.equal(r.progress.error.category,'upstream');assert.equal(diagnostics[0].httpStatus,503);assert.ok(!JSON.stringify(diagnostics).includes('private-secret'));
 c.receive({method:'item/reasoning/summaryTextDelta',params:{threadId:'one',delta:'not persisted'}});assert.equal(r.progress.phase,'resumed');assert.ok(!JSON.stringify(diagnostics).includes('not persisted'));
 c.receive({method:'error',params:{threadId:'one',willRetry:true,error:{message:'Stream failed',codexErrorInfo:'responseStreamDisconnected'}}});assert.equal(r.progress.phase,'reconnecting');
 c.receive({method:'item/started',params:{threadId:'one',item:{type:'webSearch'}}});assert.equal(r.progress.phase,'resumed');
 c.receive({method:'error',params:{threadId:'one',willRetry:true,error:{message:'Too many requests',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}}}});assert.equal(r.progress.error.category,'rate_limit');
});
