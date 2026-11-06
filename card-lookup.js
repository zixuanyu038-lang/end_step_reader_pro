'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const clone=x=>JSON.parse(JSON.stringify(x));
class Cards{
  constructor(known,cacheDir){this.known=new Map(known.map(c=>[c.name,clone(c)]));this.cacheDir=cacheDir;}
  async get(name){
    if(this.known.has(name))return clone(this.known.get(name));
    const file=path.join(this.cacheDir,crypto.createHash('sha256').update(name).digest('hex')+'.json');let raw;
    try{raw=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
    if(!raw){
      await new Promise(r=>setTimeout(r,150));
      const response=await fetch('https://api.scryfall.com/cards/named?exact='+encodeURIComponent(name),{headers:{'User-Agent':'EndstepStudio/0.2 (local replay analysis)','Accept':'application/json'},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error('无法核对假设牌的英文牌面：'+name+'（'+response.status+'）。');raw=await response.json();
      await fs.mkdir(this.cacheDir,{recursive:true});await fs.writeFile(file,JSON.stringify(raw));
    }
    const face=raw.card_faces?.find(c=>c.name===name)||raw.card_faces?.[0]||raw;
    if(face.name!==name&&raw.name!==name)throw Error('假设牌名必须完整、精确：'+name+'；牌库返回 '+raw.name);
    const [typeLine,subLine='']=face.type_line.split(/ — /);const supers=['Legendary','Basic','Snow','World'];const parts=typeLine.split(' ');
    const card={name:face.name,manaCost:face.mana_cost||'',cmc:raw.cmc||0,oracleText:face.oracle_text||'',types:parts.filter(t=>!supers.includes(t)),supertypes:parts.filter(t=>supers.includes(t)),subtypes:subLine.split(' ').filter(Boolean),keywords:raw.keywords||[],color:(face.colors||raw.colors||[]).join('')||'C',power:Number(face.power)||0,toughness:Number(face.toughness)||0,loyalty:Number(face.loyalty)||0,counters:{},attachedCards:[],chosenMarks:[],stateNotes:[]};
    const other=raw.card_faces?.find(c=>c.name!==face.name);if(other){card.alternateFaceName=other.name;card.alternateOracleText=other.oracle_text||'';}
    this.known.set(name,card);return clone(card);
  }
}
module.exports={Cards};
