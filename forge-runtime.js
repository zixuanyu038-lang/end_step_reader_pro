'use strict';

const fs=require('node:fs');
const path=require('node:path');
const baseEngine='forge-2.0.15';
const engineTag=/^forge-\d+\.\d+\.\d+$/;
const selectionFile=dataDir=>path.join(dataDir,'forge-selection.json');
const updatesDir=dataDir=>path.join(dataDir,'forge-updates');

function readForgeSelection(dataDir){
  try{
    const selected=JSON.parse(fs.readFileSync(selectionFile(dataDir),'utf8'));
    const {engine,folder,sha256}=selected;
    if(engineTag.test(engine)&&typeof folder==='string'&&folder.startsWith(engine+'-')&&
      /^[a-zA-Z0-9]{6}$/.test(folder.slice(engine.length+1))&&/^[a-f0-9]{64}$/.test(sha256)){
      return {engine,sha256,forgeDir:path.join(updatesDir(dataDir),folder)};
    }
  }catch{}
  return null;
}

function forgeCacheDir(forge,dataDir){
  return forge.cacheKey?path.join(dataDir,'forge-cache',forge.cacheKey):dataDir;
}

module.exports={baseEngine,engineTag,selectionFile,updatesDir,readForgeSelection,forgeCacheDir};
