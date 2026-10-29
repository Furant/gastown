import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProject } from './workspace.mjs';

const PROJECT_ID=/^[A-Za-z0-9_-]{1,128}$/;
function fail(message){throw new Error(`Config sync failed: ${message}`)}
function canonicalId(id){if(typeof id!=='string'||!PROJECT_ID.test(id)||['__proto__','constructor','prototype'].includes(id))fail('server returned an invalid project id');return id}

export function parseMappings(values=[]){
  const parsed={};
  for(const entry of values){const at=entry.indexOf('=');if(at<1)fail('--map must be PROJECT_ID=/absolute/path');const id=entry.slice(0,at),repoPath=entry.slice(at+1);canonicalId(id);if(!path.isAbsolute(repoPath))fail(`--map path for ${id} must be absolute`);if(Object.hasOwn(parsed,id))fail(`duplicate --map for ${id}`);parsed[id]=repoPath}
  return parsed;
}

async function canonicalPath(value){try{return await fs.realpath(value)}catch{fail('declared local project path is unavailable on this node')}}
async function checkedMapping(config,id,repoPath,baseBranch){
  const candidate={...config,projects:{...config.projects,[id]:{repoPath,baseBranch}}};
  const result=await resolveProject(candidate,id);
  return {repoPath:result.repoPath,baseBranch:result.baseBranch};
}

export async function syncNodeConfig(config,manifest,options={}){
  const target=config.configPath;
  if(!path.isAbsolute(target||''))fail('config path must be absolute');
  const fsImpl=options.fsImpl||fs,lockPath=`${target}.sync.lock`,nonce=crypto.randomUUID();let handle;
  try{handle=await fsImpl.open(lockPath,'wx',0o600);await handle.writeFile(nonce);await handle.sync()}
  catch(error){await handle?.close().catch(()=>{});if(handle)await fsImpl.readFile(lockPath,'utf8').then(value=>value===nonce?fsImpl.unlink(lockPath):undefined).catch(()=>{});if(error.code==='EEXIST')fail('another config sync is in progress; retry after it finishes');throw error}
  try{return await syncNodeConfigLocked(config,manifest,options)}
  finally{
    const held=handle;await held.close().catch(()=>{});
    try{if((await fsImpl.readFile(lockPath,'utf8'))===nonce)await fsImpl.unlink(lockPath)}catch{}
  }
}

async function syncNodeConfigLocked(config,manifest,{maps={},fsImpl=fs,now=()=>new Date()}={}){
  if(!manifest||!Array.isArray(manifest.projects))fail('server returned an invalid project manifest');
  if(!path.isAbsolute(config.configPath||''))fail('config path must be absolute');
  if(typeof manifest.nodeId!=='string'||!manifest.nodeId.trim())fail('server returned an invalid node id');
  if(config.nodeId&&config.nodeId!==manifest.nodeId)fail('server manifest belongs to a different node');
  const target=config.configPath,info=await fsImpl.lstat(target);if(info.isSymbolicLink())fail('refusing a symlink config target');if(!info.isFile())fail('config target is not a regular file');
  const original=await fsImpl.readFile(target);let raw;try{raw=JSON.parse(original.toString('utf8'))}catch{fail('config file changed or is not valid JSON')}
  const assertUnchanged=async()=>{const current=await fsImpl.lstat(target);if(current.isSymbolicLink()||!current.isFile()||current.dev!==info.dev||current.ino!==info.ino)fail('config file changed during sync; retry to preserve the newer edits');const bytes=await fsImpl.readFile(target);if(!bytes.equals(original))fail('config file changed during sync; retry to preserve the newer edits')};
  if(!raw.projects||typeof raw.projects!=='object'||Array.isArray(raw.projects))fail('config projects must be an object');
  const byId=new Map();for(const project of manifest.projects){const id=canonicalId(project?.id);if(byId.has(id))fail(`server returned duplicate project ${id}`);if(!['local','remote'].includes(project.repoType)||typeof project.baseBranch!=='string'||!project.baseBranch.trim())fail(`server returned invalid project ${id}`);byId.set(id,project)}
  for(const [id] of Object.entries(maps))if(!byId.has(id))fail(`explicit mapping references unknown project ${id}`);
  const next={...raw.projects},mapped=[],missing=[];
  for(const [id,project] of byId){
    const existing=next[id];let repoPath;
    if(project.repoType==='local'){
      if(typeof project.localPath!=='string'||!path.isAbsolute(project.localPath))fail(`local project ${id} has no valid declared path`);
      const declared=await canonicalPath(project.localPath);
      if(maps[id]&&await canonicalPath(maps[id])!==declared)fail(`explicit local mapping for ${id} differs from its declared path`);
      if(existing&&await canonicalPath(existing.repoPath)!==declared)fail(`existing local mapping for ${id} differs from its declared path`);
      repoPath=declared;
    }else{
      repoPath=maps[id]||existing?.repoPath;
      if(!repoPath){missing.push(id);continue}
    }
    const validated=await checkedMapping(config,id,repoPath,project.baseBranch);
    next[id]=validated;mapped.push(id);
  }
  for(const [id,repoPath] of Object.entries(maps))if(!byId.has(id))fail(`explicit mapping references unknown project ${id}`);
  if(!mapped.length&&!missing.length)fail('manifest contains no projects to synchronize');
  const changed=JSON.stringify(next)!==JSON.stringify(raw.projects);
  if(changed){
    const parent=path.dirname(target),backupDir=path.join(parent,'.gastown-node-config-backups');
    await fsImpl.mkdir(backupDir,{recursive:true,mode:0o700});const backupStat=await fsImpl.lstat(backupDir);if(backupStat.isSymbolicLink()||!backupStat.isDirectory())fail('backup path is not a private directory');await fsImpl.chmod(backupDir,0o700);
    await assertUnchanged();
    const stamp=now().toISOString().replace(/[:.]/g,'-'),backup=path.join(backupDir,`${path.basename(target)}.${stamp}.${crypto.randomUUID()}.bak`),temp=path.join(parent,`.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    await fsImpl.writeFile(backup,original,{flag:'wx',mode:0o600});await fsImpl.chmod(backup,0o600);
    try{await fsImpl.writeFile(temp,JSON.stringify({...raw,projects:next},null,2)+'\n',{flag:'wx',mode:0o600});await fsImpl.chmod(temp,0o600);await assertUnchanged();await fsImpl.rename(temp,target)}
    catch(error){await fsImpl.rm(temp,{force:true}).catch(()=>{});throw error}
  }
  return {mapped,missing,changed};
}
