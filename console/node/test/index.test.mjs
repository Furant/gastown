import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, parseArgs, checkNode, pairNode } from '../index.mjs';
import { acquireNodeLock, writeJournal } from '../journal.mjs';

test('node sends zero capacity while a leased task occupies its only slot',async()=>{
  const signalSource=new EventEmitter(),capacities=[],job={attemptId:'attempt-1',taskId:'task-1',leaseToken:'lease'};let finish;
  const runner={running:new Map(),run(){this.running.set(job.attemptId,{});return new Promise(resolve=>{finish=()=>{this.running.delete(job.attemptId);resolve({})}})},async stop(id){this.running.delete(id);finish()}};
  let polls=0;const client={heartbeat:async()=>{},poll:async({capacity})=>{capacities.push(capacity);if(++polls===2)signalSource.emit('SIGTERM');return{jobs:polls===1?[job]:[],cancellations:[]}}};
  await startNode({maxConcurrent:1,pollIntervalMs:1},{client,capabilities:{tools:[]},signalSource,runnerFactory:()=>runner,logger:{error(){}}});
  assert.deepEqual(capacities,[1,0]);
});

test('authorization loss stops active local work instead of polling forever',async()=>{
  const signalSource=new EventEmitter(),job={attemptId:'attempt-1',taskId:'task-1',leaseToken:'lease'};let finish,stops=0,polls=0;
  const runner={running:new Map(),run(){this.running.set(job.attemptId,{});return new Promise(resolve=>{finish=()=>{this.running.delete(job.attemptId);resolve({})}})},async stop(id){stops++;this.running.delete(id);finish()}};
  const client={heartbeat:async()=>{},poll:async()=>{if(++polls===1)return{jobs:[job],cancellations:[]};const error=new Error('revoked');error.status=403;throw error}};
  await startNode({maxConcurrent:1,pollIntervalMs:1},{client,capabilities:{tools:[]},signalSource,runnerFactory:()=>runner,logger:{error(){}}});
  assert.equal(polls,2);assert.equal(stops,1);assert.equal(runner.running.size,0);
});

test('authorization loss closes the runner before draining a pending preflight job',async()=>{
  const signalSource=new EventEmitter(),job={attemptId:'pending-1',taskId:'task-pending',leaseToken:'lease'};let polls=0,release,spawned=false;
  const gate=new Promise(resolve=>{release=resolve}),runner={running:new Map(),closing:false,async run(){await gate;if(!this.closing)spawned=true},async shutdown(){this.closing=true;release()}};
  const client={heartbeat:async()=>{},poll:async()=>{if(++polls===1)return{jobs:[job],cancellations:[]};const error=new Error('revoked');error.status=401;throw error}};
  await startNode({maxConcurrent:1,pollIntervalMs:1},{client,capabilities:{tools:[]},signalSource,runnerFactory:()=>runner,logger:{error(){}}});
  assert.equal(runner.closing,true);assert.equal(spawned,false);
});

test('transient worker failures retry with a bound and then stop polling',async()=>{
  const signalSource=new EventEmitter();let polls=0;const client={heartbeat:async()=>{},poll:async()=>{polls++;const error=new Error('temporarily unavailable');error.status=503;throw error}};
  await startNode({maxConcurrent:1,pollIntervalMs:1},{client,capabilities:{tools:[]},signalSource,runnerFactory:()=>({running:new Map(),async stop(){}}),logger:{error(){}}});
  assert.equal(polls,8);
});

test('node CLI help is available without a config file',()=>assert.deepEqual(parseArgs(['--help']),{help:true}));
test('node CLI pairing is a one-shot command and rejects polling flags',()=>{
  assert.deepEqual(parseArgs(['--config','/tmp/node.json','--pair']),{configPath:'/tmp/node.json',once:false,check:false,pair:true});
  assert.throws(()=>parseArgs(['--config','/tmp/node.json','--pair','--once']),/cannot be combined/i);
});
test('pair confirmation sends the supplied code and never prints it',async()=>{
  const calls=[],logs=[],result=await pairNode({pair:async code=>{calls.push(code);return {paired:true}}},{code:'sensitive-pair-code',logger:{log:value=>logs.push(value)}});
  assert.equal(result.paired,true);assert.deepEqual(calls,['sensitive-pair-code']);assert.equal(logs.some(value=>value.includes('sensitive-pair-code')),false);
});
test('node preflight checks local setup and authenticates without polling for work',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'town-preflight-')),repo=path.join(dir,'repo'),home=path.join(dir,'worktrees');await fs.mkdir(repo);await fs.mkdir(home);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore'});git('init','-q');const base=execFileSync('git',['symbolic-ref','--short','HEAD'],{cwd:repo,encoding:'utf8'}).trim();git('config','user.email','fixture@example.test');git('config','user.name','Fixture');await fs.writeFile(path.join(repo,'README.md'),'base');git('add','.');git('commit','-qm','init');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let heartbeats=0,polls=0;const client={heartbeat:async()=>{heartbeats++},poll:async()=>{polls++}};const logs=[];
  await checkNode({serverUrl:'http://localhost:8768',projects:{p:{repoPath:repo,baseBranch:base}},tools:{codex:{command:process.execPath}},worktreesDir:home},{client,capabilities:{tools:[{tool:'codex',models:[{id:'fixture'}]}]},logger:{log:line=>logs.push(line)}});
  assert.equal(heartbeats,1);assert.equal(polls,0);assert.ok(logs.some(line=>line.includes('Server authentication: OK')));
});

test('restart recovery runs under the node lock before tool discovery can fail',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'town-startup-recovery-')),configPath=path.join(dir,'node.json');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const order=[],signalSource=new EventEmitter(),client={recover:async body=>{order.push(['recover',body.outcome])}};
  const config={configPath,nodeId:'fixture-node',worktreesDir:path.join(dir,'worktrees'),maxConcurrent:1,pollIntervalMs:1};
  await writeJournal(config,{attemptId:'attempt-before-discovery',taskId:'task-before-discovery',leaseToken:'lease',phase:'preparing'});
  await assert.rejects(startNode(config,{client,signalSource,discoverCapabilitiesImpl:async()=>{order.push(['discover']);throw new Error('fixture discovery failure')},logger:{error(){}}}),/fixture discovery failure/);
  assert.deepEqual(order,[['recover','unknown'],['discover']]);
  await acquireNodeLock(config).then(release=>release());
});
