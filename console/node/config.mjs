import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function fail(message){throw new Error(`Invalid node config: ${message}`)}

export async function loadConfig(file,env=process.env){
  if(!file||!path.isAbsolute(file))fail('--config must be an absolute file path');
  const stat=await fs.stat(file);if(!stat.isFile())fail('config path is not a file');
  if(process.platform!=='win32'&&(stat.mode&0o077)!==0)fail('config file must be mode 0600 or stricter');
  if(stat.size>256*1024)fail('config file exceeds 256KB');
  let raw;try{raw=JSON.parse(await fs.readFile(file,'utf8'))}catch{fail('config file is not valid JSON')}
  let endpoint;try{endpoint=new URL(raw.serverUrl)}catch{fail('serverUrl must be a URL')}
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)fail('serverUrl must be an HTTP(S) origin or base path');
  if(endpoint.protocol==='http:'&&!['localhost','127.0.0.1','::1'].includes(endpoint.hostname))fail('remote serverUrl must use HTTPS');
  if(!raw.projects||typeof raw.projects!=='object'||Array.isArray(raw.projects))fail('projects mapping is required');
  for(const [id,p] of Object.entries(raw.projects)){
    if(!id||id.length>200||!p||typeof p.repoPath!=='string'||!path.isAbsolute(p.repoPath)||typeof p.baseBranch!=='string'||!p.baseBranch.trim())fail(`invalid project mapping ${id}`);
  }
  if(!raw.tools||typeof raw.tools!=='object'||Array.isArray(raw.tools))fail('tools mapping is required');
  for(const [tool,value] of Object.entries(raw.tools))if(!['codex','cursor'].includes(tool)||!value||typeof value.command!=='string'||!path.isAbsolute(value.command))fail(`tools.${tool}.command must be an absolute executable path`);
  const token=env.GAS_TOWN_NODE_TOKEN||raw.token;
  if(typeof token!=='string'||token.length<24||token.length>512)fail('set GAS_TOWN_NODE_TOKEN (at least 24 characters) or a local token in a 0600 config');
  return Object.freeze({...raw,codex:raw.tools.codex,cursor:raw.tools.cursor,serverUrl:endpoint.toString().replace(/\/$/,''),token,configPath:file,worktreesDir:raw.worktreesDir||path.join(os.homedir(),'.gastown-console','worktrees'),pollIntervalMs:Math.max(1000,Math.min(60000,Number(raw.pollIntervalMs)||3000)),maxConcurrent:Math.max(1,Math.min(4,Number(raw.maxConcurrent)||1))});
}
