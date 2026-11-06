'use strict';
const text={type:'string'},integer={type:'integer'},strings={type:'array',items:text};
const array=items=>({type:'array',items});
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const enumeration=(...values)=>({type:'string',enum:values});
const assumption=object({id:text,playerId:text,basis:text,confidence:enumeration('high','medium','low')});
const routeStep=object({actorId:text,action:enumeration('cast','activate','play_land','pass','phase','choice','combat'),cardName:text,description:text,payment:text});
const manaAudit=object({availableSources:array(object({cardId:integer,name:text,tapped:{type:'boolean'},colors:strings,amount:integer})),availablePool:text,spellCost:text,modifiers:strings,paymentPlan:strings,remainingMana:text,legal:{type:'boolean'},uncertainties:strings});
const extractedPlan=object({understoodIntent:text,feasible:{type:'boolean'},issues:strings,manaAudit,proposedLine:array(routeStep),assumptionsNeeded:strings});
const finding=object({sourceLine:integer,title:text,severity:enumeration('mistake','alternative','good'),confidence:enumeration('high','medium','low'),observed:text,analysis:text,recommended:text,manaAudit,proposedLine:array(routeStep),hiddenInformation:strings});
const review=object({summary:text,overallPlan:text,games:array(object({game:integer,summary:text,findings:array(finding)})),hiddenHands:array(object({sourceLine:integer,playerId:text,cards:array(object({name:text,count:integer})),basis:text,confidence:enumeration('high','medium','low'),alternatives:strings})),takeaways:strings});
const reviewPatch=object({replacements:array(object({originalSourceLine:integer,finding}))});
const overview=object({summary:text,overallPlan:text,takeaways:strings});
const zone=enumeration('hand','battlefield','graveyard','exile','library');
const phases=['UNTAP','UPKEEP','DRAW','MAIN1','BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS','COMBAT_DAMAGE','END_COMBAT','MAIN2','END_STEP','CLEANUP'];
const op=(name,fields)=>object({op:{type:'string',enum:[name]},...fields});
const commands={anyOf:[
  op('phase',{phase:enumeration(...phases)}),op('next_turn',{playerId:text}),
  op('draw',{playerId:text,count:integer}),op('shuffle',{playerId:text}),
  op('play_land',{cardId:integer}),op('cast',{cardId:integer,targets:strings,modes:strings}),
  op('activate',{cardId:integer,text:text}),op('trigger',{cardId:integer,text:text}),op('resolve',{}),
  op('move',{cardId:integer,to:zone}),op('life',{playerId:text,delta:integer}),
  op('tap',{cardId:integer,tapped:{type:'boolean'}}),op('mana',{cardId:integer,color:enumeration('W','U','B','R','G','C'),amount:integer}),
  op('counters',{cardId:integer,name:text,delta:integer}),op('damage',{cardId:integer,amount:integer}),
  op('transform',{cardId:integer,name:text}),op('choose_name',{cardId:integer,name:text}),op('attack',{cardIds:array(integer)}),
  op('token',{playerId:text,cardId:integer,name:text,power:integer,toughness:integer,types:strings,keywords:strings}),
  op('block',{blockerId:integer,attackerId:integer}),op('concede',{playerId:text}),op('finish',{})
]};
const branch=object({title:text,summary:text,assumptions:array(assumption),hiddenHands:array(object({playerId:text,cards:strings,assumptionId:text})),libraries:array(object({playerId:text,cards:array(object({id:integer,name:text})),assumptionId:text})),steps:array(object({actorId:text,label:text,explanation:text,rule:text,assumptionRefs:strings,commands:array(commands)})),stopReason:text});
const verification=object({accepted:{type:'boolean'},issues:array(object({step:integer,message:text})),summary:text});
function validate(value,s,path='$'){
  const fail=message=>{const e=Error(path+'：'+message);e.code='schema_error';throw e;};
  if(s.anyOf){let matches=0;for(const part of s.anyOf)try{validate(value,part,path);matches++;}catch{}if(!matches)fail('不符合允许的动作格式。');return;}
  if(s.enum&&!s.enum.includes(value))fail('取值不在协议范围内。');
  if(s.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('需要对象。');
    for(const key of s.required||[])if(!Object.hasOwn(value,key))fail('缺少字段 '+key);
    for(const key of Object.keys(value)){if(!Object.hasOwn(s.properties,key))fail('存在额外字段 '+key);validate(value[key],s.properties[key],path+'.'+key);}
  }else if(s.type==='array'){if(!Array.isArray(value)||value.length>1500)fail('数组无效或过长。');value.forEach((v,i)=>validate(v,s.items,path+'['+i+']'));}
  else if(s.type==='integer'){if(!Number.isSafeInteger(value))fail('需要安全整数。');}
  else if(s.type==='string'){if(typeof value!=='string'||value.length>30000)fail('文字无效或过长。');}
  else if(s.type==='boolean'&&typeof value!=='boolean')fail('需要布尔值。');
}
module.exports={review,reviewPatch,overview,branch,verification,extractedPlan,validate,phases};
