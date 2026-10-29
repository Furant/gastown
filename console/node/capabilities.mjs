import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexCapabilities, cursorCapabilities, parseCodexCatalog } from './tools.mjs';
const execFileAsync=promisify(execFile);
const CACHE_LIMIT=8*1024*1024;

export async function discoverCapabilities(config,{env=process.env,home=os.homedir(),execFileImpl=execFileAsync}={}){
  const tools=[];
  if(config.codex){
    const cache=path.join(env.CODEX_HOME||path.join(home,'.codex'),'models_cache.json');
    let models=[];try{const stat=await fs.stat(cache);if(stat.size<=CACHE_LIMIT)models=parseCodexCatalog(JSON.parse(await fs.readFile(cache,'utf8')))}catch{}
    tools.push({tool:'codex',models});
  }
  if(config.cursor){
    let models=[];
    try{const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('GIT_')));const result=await execFileImpl(config.cursor.command,['models'],{timeout:5000,maxBuffer:1024*1024,encoding:'utf8',windowsHide:true,env:childEnv});models=cursorCapabilities(String(result.stdout||'').split(/\r?\n/))}catch{}
    tools.push({tool:'cursor',models});
  }
  return {tools};
}
