import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { WorkerClient } from '../node/client.mjs';
import { AgentRunner } from '../node/runner.mjs';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));

test('one existing node and connection gain a second project without replacing credentials', {timeout:40000}, async t=>{
 const dir=await mkdtemp(join(tmpdir(),'node-edit-multiple-')),worktreesDir=join(dir,'trees');await mkdir(worktreesDir);
 const repos=[];
 for(const name of ['first','second']){
  const repo=join(dir,name);await mkdir(repo);const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,env,stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');await writeFile(join(repo,'README.md'),name+' base');git('add','.');git('commit','-qm','base');repos.push(repo);
 }
 const fixture=join(dir,'fixture-codex');await writeFile(fixture,`#!/usr/bin/env node
const plan=process.argv.includes('read-only');if(!plan)require('node:fs').writeFileSync('README.md','second project executed');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:plan?JSON.stringify({summary:'Second project plan',steps:[{title:'Edit README',acceptance:'Isolated result'}]}):'Second project complete'}}));`,{mode:0o700});
 const db=await createDatabase({dataDir:':memory:'}),app=await createApp({db});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;let cookie,csrf,runner;
 t.after(async()=>{await runner?.shutdown();app.closeAllConnections();await new Promise(r=>app.close(r));await db.close();await rm(dir,{recursive:true,force:true})});
 async function api(path,body,method=body===undefined?'GET':'POST'){
  const r=await fetch(base+'/api/v1'+path,{method,headers:{origin:base,'content-type':'application/json',...(cookie?{cookie,'x-csrf-token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const payload=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${payload.error?.message}`);return{data:payload.data,headers:r.headers};
 }
 const boot=await api('/auth/bootstrap',{organization:'Node edit fixture',name:'Owner',email:'node-editor@example.test',password:randomBytes(24).toString('hex')});cookie=boot.headers.get('set-cookie').split(';')[0];csrf=boot.data.csrfToken;
 const projects=[];for(const name of ['first','second'])projects.push((await api('/projects',{name,repoUrl:`https://github.com/fixture/${name}.git`,baseBranch:'main',visibility:'private'})).data);
 const node=(await api('/nodes',{name:'Original machine',visibility:'private',projectIds:[projects[0].id]})).data,client=new WorkerClient({serverUrl:base,token:node.token});
 const capabilities={tools:[{tool:'codex',models:[{id:'fixture',name:'Fixture',modes:['high'],nativeByMode:{high:'fixture'}}]}]};await client.heartbeat(capabilities);
 const connection=(await api('/connections',{name:'Existing Codex',nodeId:node.id,tool:'codex',visibility:'private',projectIds:[projects[0].id],model:'fixture',mode:'high',allowedModels:['fixture'],allowOverride:false,maxConcurrency:1})).data;
 const edited=(await api('/nodes/'+node.id,{name:'Renamed machine',projectIds:projects.map(p=>p.id)},'PATCH')).data;assert.equal(edited.id,node.id);assert.deepEqual(edited.projectIds,projects.map(p=>p.id));assert.equal(JSON.stringify(edited).includes(node.token),false);
 const changed=(await api('/connections/'+connection.id,{projectIds:projects.map(p=>p.id)},'PATCH')).data;assert.equal(changed.id,connection.id);assert.equal(changed.nodeId,node.id);await client.heartbeat(capabilities);
 const configPath=join(dir,'node-config.json');await writeFile(configPath,JSON.stringify({serverUrl:base,projects:{[projects[0].id]:{repoPath:repos[0],baseBranch:'main'}},worktreesDir,tools:{codex:{command:fixture}},customOption:'retained'}),{mode:0o600});
 const syncedRun=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../node/index.mjs',import.meta.url)),'--config',configPath,'--sync-config','--map',projects[1].id+'='+repos[1]],{cwd:dir,env:{...env,GAS_TOWN_NODE_TOKEN:node.token},timeout:10000});assert.equal(syncedRun.stdout.includes(node.token),false);
 const config=JSON.parse(await readFile(configPath,'utf8'));assert.equal(config.customOption,'retained');assert.equal(Object.keys(config.projects).length,2);assert.equal((await stat(configPath)).mode&0o777,0o600);assert.equal((await readdir(join(dir,'.gastown-node-config-backups'))).length,1);
 runner=new AgentRunner({config:{...config,configPath,nodeId:node.id,codex:config.tools.codex},capabilities:{tools:{codex:{models:capabilities.tools[0].models}}},client,logger:{error(){}}});
 const task=(await api('/tasks',{title:'Second project task',description:'Run on the existing machine and connection',projectId:projects[1].id,connectionId:connection.id})).data;await runner.run((await client.poll({capacity:1})).jobs[0]);await api('/tasks/'+task.id+'/approve',{allowPush:false,allowPR:false});const result=await runner.run((await client.poll({capacity:1})).jobs[0]);
 assert.equal(await readFile(join(result.worktree.path,'README.md'),'utf8'),'second project executed');assert.equal(await readFile(join(repos[0],'README.md'),'utf8'),'first base');assert.equal(await readFile(join(repos[1],'README.md'),'utf8'),'second base');assert.equal((await api('/tasks/'+task.id)).data.status,'awaiting_review');
 const queued=(await api('/tasks',{title:'First project queued',description:'Must be canceled on grant removal',projectId:projects[0].id,connectionId:connection.id})).data;await api('/nodes/'+node.id,{projectIds:[projects[1].id]},'PATCH');assert.equal((await api('/tasks/'+queued.id)).data.status,'canceled');assert.equal((await api('/tasks/'+task.id)).data.status,'awaiting_review');await client.heartbeat(capabilities);assert.deepEqual((await client.config()).projects.map(p=>p.id),[projects[1].id]);
});
