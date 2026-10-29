import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { generateCheckpointKeys, sealCheckpoint, openCheckpoint, checkpointDigest } from '../shared/checkpoint-crypto.mjs';

const execFileAsync=promisify(execFile);
export const MAX_CHECKPOINT_BYTES=8*1024*1024;
const TEMPLATE_ENV=/^\.env\.(?:example|sample|template|dist)$/i;
const PRIVATE_DATA_DIRS=new Set(['.ssh','.aws','.azure','.gnupg','.kube','private-keys','private_keys']);
const CREDENTIAL_DATA_DIRS=new Set(['secrets','credentials']);
const SECRET_NAME=/(?:credential|secret|token|password|api[-_.]?key|auth)/i;
const SECRET_DATA_EXT=/\.(?:json|ya?ml|toml|ini|conf|config|env|txt|pem|p12|key)$/i;
const PRIVATE_KEY_NAME=/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|checkpoint-keys\.json|node-config\.json)$/i;
function credentialLikePath(value){
  const segments=value.replaceAll('\\','/').split('/'),base=segments.at(-1);
  if(segments.some(segment=>PRIVATE_DATA_DIRS.has(segment.toLowerCase())))return true;
  if(segments.slice(0,-1).some(segment=>CREDENTIAL_DATA_DIRS.has(segment.toLowerCase()))&&SECRET_DATA_EXT.test(base))return true;
  if(TEMPLATE_ENV.test(base))return false;
  if(/^\.env(?:$|[._-])/i.test(base)||PRIVATE_KEY_NAME.test(base))return true;
  if(/\.(?:pem|p12|key)$/i.test(base))return true;
  if(/^(?:credentials?|secrets?|tokens?|passwords?|auth)$/i.test(base))return true;
  return SECRET_NAME.test(base)&&SECRET_DATA_EXT.test(base);
}
async function git(cwd,args,env={}){const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));return execFileAsync('git',args,{cwd,env:{...clean,...env,GIT_TERMINAL_PROMPT:'0'},encoding:'buffer',maxBuffer:MAX_CHECKPOINT_BYTES*2,windowsHide:true})}
async function gitInput(cwd,args,input){return new Promise((resolve,reject)=>{const child=spawn('git',args,{cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0'},windowsHide:true,stdio:['pipe','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8').slice(0,2000)});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(stderr||`git ${args[0]} failed`)));child.stdin.end(input)})}
function text(result){return result.stdout.toString('utf8').trim()}
async function safePaths(cwd){
  const {stdout:tree}=await git(cwd,['ls-tree','-r','-z','HEAD']);
  for(const record of tree.toString('utf8').split('\0').filter(Boolean)){const tab=record.indexOf('\t'),meta=record.slice(0,tab),name=record.slice(tab+1),mode=meta.split(' ')[0];if(credentialLikePath(name))throw new Error('Checkpoint contains an unsafe or credential-like path');if(mode==='120000')throw new Error('Checkpoint contains a symbolic link');if(mode==='160000')throw new Error('Checkpoint with submodules is not supported')}
  const {stdout}=await git(cwd,['status','--porcelain=v1','-z','--untracked-files=all']);
  const entries=stdout.toString('utf8').split('\0').filter(Boolean);const paths=[];
  for(let i=0;i<entries.length;i++){
    const entry=entries[i],name=entry.slice(3);paths.push(name);
    if(entry.startsWith('R')||entry.startsWith('C'))paths.push(entries[++i]||'');
  }
  for(const name of paths){if(!name||path.isAbsolute(name)||name.split(/[\\/]/).includes('..')||credentialLikePath(name))throw new Error('Checkpoint contains an unsafe or credential-like path');
    const full=path.join(cwd,name),stat=await fs.lstat(full).catch(()=>null);if(!stat)continue;
    if(stat.isSymbolicLink())throw new Error('Checkpoint contains a symbolic link');
    const [resolved,realCwd]=await Promise.all([fs.realpath(full),fs.realpath(cwd)]),rel=path.relative(realCwd,resolved);if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('Checkpoint path escapes the task worktree');
    for(let parent=path.dirname(full);parent!==cwd&&parent.startsWith(`${cwd}${path.sep}`);parent=path.dirname(parent))if(await fs.lstat(path.join(parent,'.git')).then(()=>true).catch(()=>false))throw new Error('Checkpoint contains a nested repository or submodule');
  }
  const {stdout:submodules}=await git(cwd,['ls-files','--stage','-z']);
  if(submodules.toString('utf8').split('\0').some(row=>row.startsWith('160000 ')))throw new Error('Checkpoint with submodules is not supported');
  return paths;
}
async function rejectSensitiveHistoryPaths(cwd,base,head){
  const {stdout}=await git(cwd,['log','--format=','--name-only','-z',`${base}..${head}`]);
  if(stdout.length>32*1024*1024)throw new Error('Checkpoint commit path history exceeds the safe inspection limit');
  if(stdout.toString('utf8').split('\0').some(name=>name&&credentialLikePath(name)))throw new Error('Checkpoint history contains a credential-like path');
}

// Produce a self-contained encrypted archive without touching the user's index or branch.
export async function exportCheckpoint(worktree,{privateKey,targetPublicKey,context}={}){
  const cwd=worktree.path;await safePaths(cwd);
  const head=text(await git(cwd,['rev-parse','HEAD'])),base=text(await git(cwd,['rev-parse',`refs/heads/${worktree.project.baseBranch}^{commit}`]));
  await git(cwd,['merge-base','--is-ancestor',base,head]);
  await rejectSensitiveHistoryPaths(cwd,base,head);
  const indexPath=text(await git(cwd,['rev-parse','--git-path','index']));
  const absoluteIndex=path.isAbsolute(indexPath)?indexPath:path.resolve(cwd,indexPath);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gastown-checkpoint-'));
  const tempIndex=path.join(temp,'index'),refId=randomUUID(),ref=`refs/gastown-checkpoints/${refId}`;
  try{
    await fs.copyFile(absoluteIndex,tempIndex).catch(async error=>{if(error.code==='ENOENT')await fs.writeFile(tempIndex,'');else throw error});
    const env={GIT_INDEX_FILE:tempIndex};
    const stagedTree=text(await git(cwd,['write-tree'],env));
    const stagedCommit=text(await git(cwd,['-c','user.name=Gas Town Checkpoint','-c','user.email=checkpoint.invalid','commit-tree',stagedTree,'-p',head,'-m','Temporary Gas Town checkpoint index'],env));
    await git(cwd,['add','-A'],env);
    const tree=text(await git(cwd,['write-tree'],env));
    const commit=text(await git(cwd,['-c','user.name=Gas Town Checkpoint','-c','user.email=checkpoint.invalid','commit-tree',tree,'-p',stagedCommit,'-m','Temporary Gas Town checkpoint worktree'],env));
    await git(cwd,['update-ref',ref,commit]);
    const bundlePath=path.join(temp,'checkpoint.bundle');await git(cwd,['bundle','create',bundlePath,ref,`^${base}`]);
    const bundle=await fs.readFile(bundlePath);if(bundle.length>Math.floor(MAX_CHECKPOINT_BYTES*0.72))throw new Error('Checkpoint git bundle exceeds the safe 8 MiB plaintext envelope limit');
    const plaintext=Buffer.from(JSON.stringify({version:1,base,head,stagedTree,stagedCommit,tree,commit,refId,bundle:bundle.toString('base64')}));
    if(plaintext.length>MAX_CHECKPOINT_BYTES)throw new Error('Checkpoint exceeds the 8 MiB plaintext limit');
    const envelope=await sealCheckpoint(plaintext,targetPublicKey,context);
    return {envelope,digest:checkpointDigest(envelope),head};
  }finally{await git(cwd,['update-ref','-d',ref]).catch(()=>{});await fs.rm(temp,{recursive:true,force:true})}
}

export async function ensureNodeCheckpointKeys(config){
  if(!config.configPath)return generateCheckpointKeys();
  const file=path.join(path.dirname(config.configPath),'checkpoint-keys.json');
  let keys;
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Checkpoint private key path must be a regular file');if(process.platform!=='win32'&&(stat.mode&0o077)!==0)throw new Error('Checkpoint private key file must be mode 0600');if(stat.size>16*1024)throw new Error('Checkpoint private key file is too large');keys=JSON.parse(await fs.readFile(file,'utf8'))}
  catch(error){if(error.code!=='ENOENT')throw error;keys=await generateCheckpointKeys();await fs.writeFile(file,JSON.stringify(keys),{mode:0o600,flag:'wx'});await fs.chmod(file,0o600)}
  if(typeof keys.privateKey!=='string'||typeof keys.publicKey!=='string')throw new Error('Stored checkpoint key pair is invalid');
  return {privateKey:keys.privateKey,publicKey:keys.publicKey};
}

function checkpointStatePath(worktree){return path.join(path.dirname(worktree.path),`${path.basename(worktree.path)}.checkpoint-state.json`)}
export async function hasCheckpointState(worktree,{context,digest}={}){
  try{const file=checkpointStatePath(worktree),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077)!==0)return false;const state=JSON.parse(await fs.readFile(file,'utf8'));return state.version===1&&state.digest===digest&&JSON.stringify(state.context)===JSON.stringify(context)}catch{return false}
}
async function writeCheckpointState(worktree,{context,digest}){
  const file=checkpointStatePath(worktree),temp=`${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp,JSON.stringify({version:1,context,digest}),{mode:0o600,flag:'wx'});
  try{await fs.rename(temp,file)}catch(error){await fs.rm(temp,{force:true});throw error}
}

export async function importCheckpoint(worktree,{envelope,privateKey,context,digest}={}){
  if(checkpointDigest(envelope)!==digest)throw new Error('Checkpoint digest verification failed');
  const plaintext=await openCheckpoint(envelope,privateKey,context);if(plaintext.length>MAX_CHECKPOINT_BYTES)throw new Error('Checkpoint exceeds the 8 MiB plaintext limit');
  const record=JSON.parse(plaintext.toString('utf8'));if(record.version!==1||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)||typeof record.bundle!=='string')throw new Error('Checkpoint source HEAD or format did not match');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gastown-restore-'));const bundle=path.join(temp,'checkpoint.bundle');
  try{
    await fs.writeFile(bundle,Buffer.from(record.bundle,'base64'),{mode:0o600});
    if(!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(record.base)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head))throw new Error('Checkpoint source base or HEAD is invalid');
    await git(worktree.path,['cat-file','-e',`${record.base}^{commit}`]).catch(()=>{throw new Error('Target project is missing the checkpoint base commit; sync the project clone before retrying')});
    await git(worktree.path,['fetch',bundle,`refs/gastown-checkpoints/${record.refId}:refs/gastown-checkpoints/imported/${record.refId}`]);
    const verify=text(await git(worktree.path,['rev-parse',`${record.stagedCommit}^`])).trim();if(verify!==record.head||text(await git(worktree.path,['rev-parse',`${record.commit}^`]))!==record.stagedCommit)throw new Error('Checkpoint source HEAD verification failed');
    await git(worktree.path,['reset','--mixed',record.head]);
    const commit=text(await git(worktree.path,['rev-parse',`refs/gastown-checkpoints/imported/${record.refId}`])).trim();
    if(commit!==record.commit||text(await git(worktree.path,['rev-parse',`${commit}^{tree}`]))!==record.tree)throw new Error('Checkpoint commit/tree verification failed');
    if(text(await git(worktree.path,['rev-parse',`${record.stagedCommit}^{tree}`]))!==record.stagedTree)throw new Error('Checkpoint staged index tree verification failed');
    const stagedPatch=(await git(worktree.path,['diff','--binary',record.head,record.stagedCommit])).stdout;
    if(stagedPatch.length)await gitInput(worktree.path,['apply','--binary','--cached'],stagedPatch);
    await git(worktree.path,['checkout-index','-f','-a']);
    const workPatch=(await git(worktree.path,['diff','--binary',record.stagedCommit,commit])).stdout;
    if(workPatch.length)await gitInput(worktree.path,['apply','--binary'],workPatch);
    await writeCheckpointState(worktree,{context,digest});
    return {head:record.head,restored:true};
  }finally{await git(worktree.path,['for-each-ref','--format=%(refname)','refs/gastown-checkpoints/imported/']).then(async result=>{for(const ref of result.stdout.toString('utf8').split('\n').filter(Boolean))await git(worktree.path,['update-ref','-d',ref])}).catch(()=>{});await fs.rm(temp,{recursive:true,force:true})}
}
