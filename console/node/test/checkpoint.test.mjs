import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { generateCheckpointKeys } from '../../shared/checkpoint-crypto.mjs';
import { exportCheckpoint, importCheckpoint, ensureNodeCheckpointKeys, hasCheckpointState } from '../checkpoint.mjs';
import { ensureWorktree, resolveProject } from '../workspace.mjs';
const run=promisify(execFile);
async function git(cwd,...args){return (await run('git',args,{cwd,encoding:'utf8'})).stdout.trim()}
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'town-two-node-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source'),target=path.join(dir,'target'),sourceTrees=path.join(dir,'source-trees'),targetTrees=path.join(dir,'target-trees');
 await fs.mkdir(source);await git(source,'init','-b','main');await git(source,'config','user.name','Fixture');await git(source,'config','user.email','fixture@example.invalid');
 await fs.writeFile(path.join(source,'tracked.txt'),'base\n');await git(source,'add','.');await git(source,'commit','-m','fixture base');
 await git(dir,'clone',source,target);await git(target,'config','user.name','Fixture');await git(target,'config','user.email','fixture@example.invalid');
 const sourceProject={id:'project',repoPath:source,baseBranch:'main',worktreesDir:sourceTrees},targetProject={id:'project',repoPath:target,baseBranch:'main',worktreesDir:targetTrees};
 const sourceWT=await ensureWorktree(sourceProject,'task-checkpoint');return{dir,source,target,sourceWT,targetProject};
}
const context={taskId:'task-checkpoint',projectId:'project',sourceAttemptId:'attempt-source',targetNodeId:'node-target',transferId:'transfer-1'};
test('encrypted checkpoint restores tracked, staged and untracked changes across two clones without changing source index',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys();
 await fs.writeFile(path.join(f.sourceWT.path,'committed.txt'),'source committed delta\n');await git(f.sourceWT.path,'add','committed.txt');await git(f.sourceWT.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture committed source delta');
 await fs.writeFile(path.join(f.sourceWT.path,'tracked.txt'),'staged\n');await git(f.sourceWT.path,'add','tracked.txt');
 await fs.writeFile(path.join(f.sourceWT.path,'tracked.txt'),'working tree\n');await fs.writeFile(path.join(f.sourceWT.path,'new.txt'),'untracked\n');
 const sourceStatus=await git(f.sourceWT.path,'status','--porcelain=v1');const checkpoint=await exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context});
 assert.equal(await git(f.sourceWT.path,'status','--porcelain=v1'),sourceStatus);
 const targetWT=await ensureWorktree(f.targetProject,'task-checkpoint');
 await importCheckpoint(targetWT,{envelope:checkpoint.envelope,privateKey:keys.privateKey,context,digest:checkpoint.digest});
 assert.equal(await hasCheckpointState(targetWT,{context,digest:checkpoint.digest}),true);
 assert.equal(await fs.readFile(path.join(targetWT.path,'tracked.txt'),'utf8'),'working tree\n');assert.equal(await fs.readFile(path.join(targetWT.path,'new.txt'),'utf8'),'untracked\n');
 assert.equal(await fs.readFile(path.join(targetWT.path,'committed.txt'),'utf8'),'source committed delta\n');
 assert.equal((await git(targetWT.path,'diff','--cached','--name-only')),'tracked.txt');
 assert.match(await git(targetWT.path,'status','--porcelain=v1'),/^MM tracked\.txt/m);
});
test('checkpoint import rejects wrong recipient context and digest',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys(),checkpoint=await exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),targetWT=await ensureWorktree(f.targetProject,'task-checkpoint');
 await assert.rejects(importCheckpoint(targetWT,{envelope:checkpoint.envelope,privateKey:keys.privateKey,context:{...context,targetNodeId:'wrong'},digest:checkpoint.digest}),/authenticate|context/i);
 await assert.rejects(importCheckpoint(targetWT,{envelope:checkpoint.envelope,privateKey:keys.privateKey,context,digest:'0'.repeat(64)}),/digest/i);
});
test('checkpoint export rejects credential-like paths and symlink escapes',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys();await fs.writeFile(path.join(f.sourceWT.path,'.env'),'fixture=not-a-secret-value');
 await assert.rejects(exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),/credential-like/);
 await fs.rm(path.join(f.sourceWT.path,'.env'));await fs.symlink(path.join(f.dir,'outside'),path.join(f.sourceWT.path,'linked'));
 await assert.rejects(exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),/symbolic link/);
});
test('checkpoint rejects a credential-like path already present in committed HEAD',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys();await fs.writeFile(path.join(f.sourceWT.path,'credentials.json'),'fixture-data-only');await git(f.sourceWT.path,'add','credentials.json');await git(f.sourceWT.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture credential path');
 await assert.rejects(exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),/credential-like/);
});
test('checkpoint rejects credential paths added and deleted between the shared base and source HEAD',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys();await fs.writeFile(path.join(f.sourceWT.path,'.env'),'fixture-data-only');await git(f.sourceWT.path,'add','.env');await git(f.sourceWT.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture add credential path');await git(f.sourceWT.path,'rm','.env');await git(f.sourceWT.path,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture delete credential path');
 await assert.rejects(exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),/history contains a credential-like path/);
});
test('checkpoint allows ordinary source names containing token and password words plus env templates',async t=>{
 const f=await fixture(t),keys=generateCheckpointKeys();for(const [name,contents]of [['TokenService.java','class TokenService {}'],['password-policy.test.mjs','export const passwordPolicy = true'],['.env.example','API_TOKEN=replace-me']])await fs.writeFile(path.join(f.sourceWT.path,name),contents);
 const checkpoint=await exportCheckpoint(f.sourceWT,{targetPublicKey:keys.publicKey,context}),targetWT=await ensureWorktree(f.targetProject,'task-checkpoint');
 await importCheckpoint(targetWT,{envelope:checkpoint.envelope,privateKey:keys.privateKey,context,digest:checkpoint.digest});
 for(const name of ['TokenService.java','password-policy.test.mjs','.env.example'])assert.ok(await fs.stat(path.join(targetWT.path,name)));
});
test('checkpoint private key is persisted with restrictive permissions beside node config',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'town-node-key-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config={configPath:path.join(dir,'node.json')},first=await ensureNodeCheckpointKeys(config),second=await ensureNodeCheckpointKeys(config);
 assert.equal(first.privateKey,second.privateKey);assert.equal(first.publicKey,second.publicKey);if(process.platform!=='win32')assert.equal((await fs.stat(path.join(dir,'checkpoint-keys.json'))).mode&0o777,0o600);
});
