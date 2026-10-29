import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const writeQueues=new Map();
const safeId=value=>String(value).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,120);
export function journalDirectory(config){return path.join(path.dirname(config.configPath||config.worktreesDir),'.gastown-node-journals',safeId(config.nodeId||'node'))}
export async function writeJournal(config,record,{fsImpl=fs}={}){
  const dir=journalDirectory(config),target=path.join(dir,safeId(record.attemptId)+'.json'),serialized=JSON.stringify(record);
  const prior=writeQueues.get(target)||Promise.resolve();
  const operation=prior.catch(()=>{}).then(async()=>{await fsImpl.mkdir(dir,{recursive:true,mode:0o700});await fsImpl.chmod(dir,0o700);const tmp=target+'.'+randomUUID()+'.tmp';const handle=await fsImpl.open(tmp,'wx',0o600);try{await handle.writeFile(serialized);await handle.sync()}finally{await handle.close()}await fsImpl.rename(tmp,target);await fsImpl.chmod(target,0o600);return target});
  writeQueues.set(target,operation);
  try{return await operation}finally{if(writeQueues.get(target)===operation)writeQueues.delete(target)}
}
export async function readJournal(config,attemptId){const file=path.join(journalDirectory(config),safeId(attemptId)+'.json');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Unsafe node journal permissions or file type');if(stat.size>64*1024)throw new Error('Node journal exceeds size limit');return JSON.parse(await fs.readFile(file,'utf8'))}
export async function unresolvedJournals(config){
  const dir=journalDirectory(config);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);
  const records=[];for(const name of await fs.readdir(dir)){if(!name.endsWith('.json'))continue;const file=path.join(dir,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Unsafe node journal permissions or file type');if(stat.size>64*1024)throw new Error('Node journal exceeds size limit');const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.phase!=='terminal')records.push({...record,journalPath:file})}return records;
}
export async function identifyProcess(pid){
  if(!Number.isSafeInteger(pid)||pid<=1)return null;
  if(process.platform==='win32')return null;
  try{const {stdout}=await execFileAsync('ps',['-p',String(pid),'-o','lstart=,pgid=,args='],{timeout:2000,maxBuffer:8192});const match=stdout.trim().match(/^(.{24})\s+(\d+)\s+(.+)$/);return match?{startTime:match[1].trim(),pgid:Number(match[2]),command:match[3]}:null}catch{return null}
}
function processGroupAlive(pgid){try{process.kill(-pgid,0);return true}catch(error){if(error.code==='ESRCH')return false;return true}}
export async function acquireNodeLock(config){
  const dir=journalDirectory(config);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);const file=path.join(dir,'worker.lock');const identity=await identifyProcess(process.pid);if(!identity)throw new Error('Cannot prove current node process identity');const lock={pid:process.pid,startTime:identity.startTime,pgid:identity.pgid,lockId:randomUUID()};
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(lock));await handle.sync()}finally{await handle.close()}return async()=>{try{const current=JSON.parse(await fs.readFile(file,'utf8'));if(current.lockId===lock.lockId)await fs.unlink(file)}catch{}}}catch(error){if(error.code!=='EEXIST')throw error;let existing;try{existing=JSON.parse(await fs.readFile(file,'utf8'))}catch{throw new Error('Node worker lock is unreadable; refusing duplicate worker start')};const actual=await identifyProcess(existing.pid);if(actual&&actual.startTime===existing.startTime)throw new Error('Another worker process already owns this node configuration');const latest=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);if(latest?.lockId===existing.lockId)await fs.unlink(file).catch(unlinkError=>{if(unlinkError.code!=='ENOENT')throw unlinkError})}
  }
  throw new Error('Could not acquire node worker lock');
}
export async function recoverJournals(config,client,logger=console){
  const records=await unresolvedJournals(config);const activeTasks=new Set();
  for(const record of records){
    let outcome='unknown',message='Node restarted while this attempt was unresolved';
    if(record.phase==='running'&&record.pid&&record.identity&&process.platform!=='win32'){
      const actual=await identifyProcess(record.pid);
      const markerValid=typeof record.marker==='string'&&record.marker.length>=16;
      const matches=markerValid&&actual&&actual.startTime===record.identity.startTime&&actual.pgid===record.identity.pgid&&actual.command.includes(record.marker);
      if(!actual&&!processGroupAlive(record.identity.pgid)) {outcome='stopped';message='Recorded supervisor process group is no longer running'}
      else if(!actual){message='Supervisor is gone but its process group may still contain work; left it untouched'}
      else if(matches){try{process.kill(-record.identity.pgid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,400));const after=await identifyProcess(record.pid);if(after&&after.startTime===record.identity.startTime){process.kill(-record.identity.pgid,'SIGKILL');await new Promise(resolve=>setTimeout(resolve,100))}const final=await identifyProcess(record.pid);if((!final||final.startTime!==record.identity.startTime)&&!processGroupAlive(record.identity.pgid)){outcome='stopped';message='Verified owned process group stopped after node restart'}}catch{}}
      else message='Recorded process identity did not match; left process untouched'
    }
    let usageDeliveryFailed=false;
    for(const usage of record.usageEvents||[]){try{await client.event({attemptId:record.attemptId,leaseToken:record.leaseToken,type:'usage',message:'Provider reported tool usage',data:usage})}catch{usageDeliveryFailed=true}}
    if(usageDeliveryFailed){
      activeTasks.add(record.taskId);message='Local process containment completed or remains uncertain; provider usage delivery is pending';
      logger.error('pending usage event delivery failed','attempt retained for recovery');
      try{await client.recover({attemptId:record.attemptId,leaseToken:record.leaseToken,outcome:'unknown',message})}catch(error){logger.error('recovery remains fenced by server stop intent or API failure',String(error.message).slice(0,300))}
      continue;
    }
    const checkpoint=record.checkpoint&&{branch:record.checkpoint.branch,dirty:Boolean(record.checkpoint.dirty)};
    try{
      if(record.stopIntent&&outcome==='stopped'&&record.stopIntent.reason!=='transfer')await client.event({attemptId:record.attemptId,leaseToken:record.leaseToken,type:'stopped',message:'Verified stopped after node restart',data:{reason:record.stopIntent.reason,...(checkpoint?{checkpoint}:{})}});
      else if(record.stopIntent?.reason==='transfer'){outcome='unknown';message='Transfer intent requires an encrypted checkpoint and explicit recovery';await client.recover({attemptId:record.attemptId,leaseToken:record.leaseToken,outcome,message})}
      else await client.recover({attemptId:record.attemptId,leaseToken:record.leaseToken,outcome,...(checkpoint?{checkpoint}:{}),message});
    }catch(error){logger.error('attempt recovery report failed',String(error.message).slice(0,300));activeTasks.add(record.taskId);continue}
    if(outcome==='unknown')activeTasks.add(record.taskId);
    else{await writeJournal(config,{...record,phase:'terminal',leaseToken:undefined});}
  }
  return activeTasks;
}
