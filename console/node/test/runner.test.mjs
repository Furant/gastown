import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { AgentRunner } from '../runner.mjs';
import { ensureWorktree, resolveProject } from '../workspace.mjs';

async function setup(t, output, runnerOptions={}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'town-runner-')), repo = path.join(dir, 'repo'), home = path.join(dir, 'worktrees');
  await fs.mkdir(repo); await fs.mkdir(home);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore'});
  git('init','-q');const base=execFileSync('git',['symbolic-ref','--short','HEAD'],{cwd:repo,encoding:'utf8'}).trim();git('config','user.email','fixture@example.test');git('config','user.name','Fixture');await fs.writeFile(path.join(repo,'README.md'),'base');git('add','.');git('commit','-qm','init');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const events=[];
  const client={event:async body=>{events.push(structuredClone(body));return {ok:true}},heartbeat:async()=>{},poll:async()=>({jobs:[],cancellations:[]})};
  let active;
  const spawnImpl=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.pid=123;c.exitCode=null;c.kill=()=>{c.exitCode=0;setImmediate(()=>c.emit('close',0,null));return true};active=c;setImmediate(()=>{c.emit('spawn');if(output!==null&&output!==undefined){const exitCode=output.fixtureExitCode??0;c.stdout.write(JSON.stringify(output.record??output)+'\n');c.exitCode=exitCode;setImmediate(()=>c.emit('close',exitCode,null))}});return c};
  const runner=new AgentRunner({config:{projects:{p:{repoPath:repo,baseBranch:base}},worktreesDir:home,codex:{command:'/fixture/codex'},cursor:{command:'/fixture/agent'},maxConcurrent:2},capabilities:{tools:{codex:{models:[{id:'gpt-6.1-sol',modes:['low','high'],nativeByMode:{low:'gpt-6.1-sol',high:'gpt-6.1-sol'}}]}}},client,spawnImpl,signalProcess:async child=>child.kill('SIGTERM'),processGroupAlive:child=>child.exitCode===null,stopTimeoutMs:30,logger:{error(){}},...runnerOptions});
  return {runner,events,repo,child:()=>active};
}
const job=(extra={})=>({kind:'execute',tool:'codex',taskId:'task-42',projectId:'p',attemptId:'attempt-1',leaseToken:'opaque-lease',connectionId:'conn',model:'gpt-6.1-sol',mode:'high',title:'Add task feature',description:'Keep existing behavior',plan:{steps:[{title:'Implement',acceptance:'Tests pass'}]},allowPush:false,allowPR:false,...extra});

test('approved execution emits a final event and same task resume retains worktree', async t=>{
  const x=await setup(t,{type:'item.completed',item:{type:'agent_message',text:'Feature complete'}});
  const result=await x.runner.run(job());
  assert.equal(result.status,'completed');
  await fs.writeFile(path.join(result.worktree.path,'unfinished.md'),'preserved');
  const resumed=await x.runner.run(job({attemptId:'attempt-2'}));
  assert.equal(await fs.readFile(path.join(resumed.worktree.path,'unfinished.md'),'utf8'),'preserved');
  assert.ok(x.events.some(e=>e.type==='completed'));
});

test('PR completion is reported only with verified URL evidence',async t=>{
  const url='https://github.com/team/repo/pull/12',x=await setup(t,{type:'result',result:'PR created'}, {verifyPullRequestImpl:async()=>url});
  const result=await x.runner.run(job({allowPush:true,allowPR:true}));assert.equal(result.prUrl,url);assert.equal(x.events.find(event=>event.type==='completed').data.prUrl,url);
});

test('PR output text without authoritative verification is never reported as completed',async t=>{
  const x=await setup(t,{type:'result',result:'https://github.com/team/repo/pull/12'}, {verifyPullRequestImpl:async()=>{throw new Error('gh verification unavailable')}});
  await assert.rejects(x.runner.run(job({allowPush:true,allowPR:true})),/gh verification unavailable/);assert.equal(x.events.some(event=>event.type==='completed'),false);assert.ok(x.events.some(event=>event.type==='failed'));
});

test('pause and cancel during delayed PR verification stop the already-exited attempt before completion',async t=>{
  for(const reason of ['pause','cancel']){
    let release,entered;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),url='https://github.com/team/repo/pull/12';
    const x=await setup(t,{type:'result',result:'PR created'},{verifyPullRequestImpl:async()=>{entered();await gate;return url}});
    const running=x.runner.run(job({allowPush:true,allowPR:true}));await waiting;
    await x.runner.cancel({attemptId:'attempt-1',leaseToken:'opaque-lease',reason});release();
    await assert.rejects(running,/stopped/i);assert.ok(x.events.some(event=>event.type==='stopped'&&event.data.reason===reason));assert.equal(x.events.some(event=>event.type==='completed'),false);assert.equal(x.runner.running.has('attempt-1'),false);
  }
});

test('a completion rejected by a concurrent stop intent keeps the exited session until stop acknowledgment',async t=>{
  const x=await setup(t,{type:'result',result:'Task done'}),events=x.events,original=x.runner.client.event.bind(x.runner.client);
  x.runner.client.event=async body=>{if(body.type==='completed'){const error=new Error('stop intent won completion race');error.status=409;error.code='stale_attempt';throw error}return original(body)};
  await assert.rejects(x.runner.run(job()),/stop intent won/);assert.equal(x.runner.running.has('attempt-1'),true);assert.equal(x.runner.pending.has('attempt-1'),true);
  await x.runner.cancel({attemptId:'attempt-1',leaseToken:'opaque-lease',reason:'cancel'});
  assert.ok(events.some(event=>event.type==='stopped'&&event.data.reason==='cancel'));assert.equal(events.some(event=>event.type==='completed'),false);assert.equal(x.runner.running.has('attempt-1'),false);assert.equal(x.runner.pending.has('attempt-1'),false);
});

test('quota failover event includes a checkpoint after process-group cleanup',async t=>{
  const x=await setup(t,{fixtureExitCode:1,record:{type:'error',code:'usage_limit_reached',message:'Model usage limit reached'}});await assert.rejects(x.runner.run(job()),/execution failed/);
  const event=x.events.find(item=>item.type==='quota_exhausted');assert.ok(event.data.checkpoint.branch);assert.equal(typeof event.data.checkpoint.dirty,'boolean');
});

test('stop kills a TERM-resistant descendant before recording the stopped checkpoint',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'town-process-group-')),repo=path.join(dir,'repo'),home=path.join(dir,'worktrees'),marker=path.join(dir,'alive');
  await fs.mkdir(repo);await fs.mkdir(home);const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore'});git('init','-q');const base=execFileSync('git',['symbolic-ref','--short','HEAD'],{cwd:repo,encoding:'utf8'}).trim();git('config','user.email','fixture@example.test');git('config','user.name','Fixture');await fs.writeFile(path.join(repo,'README.md'),'base');git('add','.');git('commit','-qm','init');
  const descendant=`process.on('SIGTERM',()=>{});setInterval(()=>require('fs').appendFileSync(${JSON.stringify(marker)},'x'),20)`;
  const parent=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const events=[],client={event:async body=>{events.push(structuredClone(body));return{}},heartbeat:async()=>{},poll:async()=>({jobs:[],cancellations:[]})};
  const runner=new AgentRunner({config:{projects:{p:{repoPath:repo,baseBranch:base}},worktreesDir:home,codex:{command:process.execPath},cursor:{command:process.execPath},maxConcurrent:1},capabilities:{tools:{codex:{models:[{id:'gpt-6.1-sol',modes:['high'],nativeByMode:{high:'gpt-6.1-sol'}}]}}},client,spawnImpl:(command,_args,options)=>nodeSpawn(command,['-e',parent],options),stopTimeoutMs:250,logger:{error(){}}});
  const running=runner.run(job());const observed=assert.rejects(running,/stopped/i);for(let i=0;i<100;i++){try{if((await fs.stat(marker)).size>0)break}catch{}await new Promise(resolve=>setTimeout(resolve,10))}
  const sizeBefore=(await fs.stat(marker)).size;await runner.stop('attempt-1');const sizeStopped=(await fs.stat(marker)).size;await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal((await fs.stat(marker)).size,sizeStopped);assert.ok(sizeStopped>=sizeBefore);assert.ok(events.some(event=>event.type==='stopped'));await observed;
});

test('stop refuses acknowledgment when the process group cannot be proven empty',async t=>{
  const x=await setup(t,null,{processGroupAlive:()=>true,signalProcess:async()=>{},forceSignalProcess:async()=>{},stopTimeoutMs:20});
  const running=x.runner.run(job()),observed=assert.rejects(running,/stopped/i);for(let i=0;i<100&&!x.runner.running.has('attempt-1');i++)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(x.runner.stop('attempt-1'),/refusing checkpoint/);assert.equal(x.events.some(event=>event.type==='stopped'),false);x.child().exitCode=1;x.child().emit('close',1,null);await observed;
});

test('a source attempt reports stopped only after its process exits and checkpoint is saved', async t=>{
  const x=await setup(t,null),promise=x.runner.run(job()),observed=assert.rejects(promise,/stopped/i);
  for(let i=0;i<100&&!x.runner.running.has('attempt-1');i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(x.child()?.exitCode,null);
  const result=await x.runner.stop('attempt-1');
  assert.equal(x.child().exitCode,0);
  assert.equal(result.stopped,true);
  const stopped=x.events.find(e=>e.type==='stopped');
  assert.equal(stopped.leaseToken,'opaque-lease');
  assert.ok(stopped.data.checkpoint.worktree.startsWith('node-worktrees/'));
  await observed;
});

test('unknown model and stale stop lease never launch or stop a process',async t=>{
  const x=await setup(t,{type:'result',result:'ok'});
  await assert.rejects(x.runner.run(job({mode:'max'})),/unsupported/i);
  await assert.rejects(x.runner.stop('unknown','opaque-lease'),/active/i);
  assert.equal(x.child(),undefined);
  assert.ok(x.events.some(e=>e.type==='failed'));
});

test('shutdown during delayed workspace preparation prevents the paid tool from spawning',async t=>{
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const x=await setup(t,null,{ensureWorktreeImpl:async(...args)=>{entered();await gate;return ensureWorktree(...args)}});
  const pending=x.runner.run(job());await waiting;await x.runner.shutdown();release();await assert.rejects(pending,/shutting down/i);assert.equal(x.child(),undefined);
});

test('pending preflight cancellation waits for launch fencing and acknowledges stopped without spawning',async t=>{
  let release,entered;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let spawned=false;
  const x=await setup(t,null,{resolveProjectImpl:async(config,id)=>{entered();await gate;return resolveProject(config,id)},spawnImpl:()=>{spawned=true;throw new Error('must not spawn')}});
  const running=x.runner.run(job()),cancelled=x.runner.cancel({attemptId:'attempt-1',leaseToken:'opaque-lease',reason:'pause'});await waiting;release();await cancelled;await assert.rejects(running,/cancelled before process launch|stopped/i);
  assert.equal(spawned,false);assert.ok(x.events.some(event=>event.type==='stopped'&&event.data.reason==='pause'));
});

test('quota failover ignores quoted quota phrases without a structured machine error',async t=>{
  const x=await setup(t,{fixtureExitCode:1,record:{type:'result',result:'Documentation quoted: "quota exceeded"; retry policy is described here.'}});await assert.rejects(x.runner.run(job()),/execution failed/);
  assert.equal(x.events.some(item=>item.type==='quota_exhausted'),false);assert.ok(x.events.some(item=>item.type==='failed'));
});
