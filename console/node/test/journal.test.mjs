import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { journalDirectory,nodeJournalNamespace,writeJournal,recoverJournals,readJournal,acquireNodeLock,identifyProcess } from '../journal.mjs';

test('node journal namespace remains stable across discovered heartbeat identity and keeps explicit legacy IDs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-namespace-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees')},namespace=nodeJournalNamespace(config),runtime={...config,journalNamespace:namespace,nodeId:'server-assigned-node'};
  assert.equal(journalDirectory(runtime),journalDirectory(config));
  assert.equal(journalDirectory({...config,nodeId:'configured-node'}),path.join(root,'.gastown-node-journals','configured-node'));
  const release=await acquireNodeLock(config);assert.equal(await fs.stat(path.join(journalDirectory(runtime),'worker.lock')).then(()=>true),true);await release();
});

test('legacy unscoped journals are warned about and never recovered for an unknown node',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json')},legacy=path.join(root,'.gastown-node-journals','node');await fs.mkdir(legacy,{recursive:true});await fs.writeFile(path.join(legacy,'old-attempt.json'),JSON.stringify({phase:'running',attemptId:'old-attempt'}),{mode:0o600});
  const logs=[],reports=[];await recoverJournals(config,{recover:async body=>reports.push(body)},{error:message=>logs.push(message)});
  assert.equal(reports.length,0);assert.equal(logs.some(message=>message.includes('left untouched')),true);assert.equal(await fs.readFile(path.join(legacy,'old-attempt.json'),'utf8'),JSON.stringify({phase:'running',attemptId:'old-attempt'}));
});

test('journals are private and recovery never signals a PID whose start identity differs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  const record={attemptId:'attempt-a',taskId:'task-a',leaseToken:'private-lease',phase:'running',pid:process.pid,marker:'not-the-current-command',identity:{startTime:'recycled-pid',pgid:process.pid}};
  const file=await writeJournal(config,record),stat=await fs.stat(file);
  if(process.platform!=='win32')assert.equal(stat.mode&0o777,0o600);
  assert.equal(path.dirname(file),journalDirectory(config));
  const reports=[],blocked=await recoverJournals(config,{recover:async value=>{reports.push(value)}},{error(){}});
  assert.deepEqual(reports.map(x=>x.outcome),['unknown']);assert.deepEqual([...blocked],['task-a']);
  assert.equal(reports[0].leaseToken,'private-lease');
});

test('dead verified supervisor reports stopped and finalizes its journal',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-dead-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  await writeJournal(config,{attemptId:'attempt-dead',taskId:'task-dead',leaseToken:'lease',phase:'running',pid:2147483647,marker:'fixture-supervisor-marker-123456',identity:{startTime:'gone',pgid:2147483647},checkpoint:{branch:'task-dead',dirty:true}});
  const reports=[];await recoverJournals(config,{recover:async value=>reports.push(value)},{error(){}});
  assert.equal(reports[0].outcome,'stopped');assert.equal(reports[0].checkpoint.dirty,true);assert.equal((await readJournal(config,'attempt-dead')).phase,'terminal');
});

test('usage delivery failure reports unknown while retaining unresolved journal and lease',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  const record={attemptId:'attempt-usage',taskId:'task-usage',leaseToken:'lease',phase:'preparing',usageEvents:[{eventId:'stable-id',inputTokens:12,outputTokens:3}]};await writeJournal(config,record);
  const reports=[];const blocked=await recoverJournals(config,{event:async()=>{throw new Error('offline')},recover:async value=>reports.push(value)},{error(){}});
  assert.deepEqual([...blocked],['task-usage']);assert.equal(reports[0].outcome,'unknown');assert.match(reports[0].message,/containment.*usage delivery/i);assert.equal((await readJournal(config,'attempt-usage')).phase,'preparing');assert.equal((await readJournal(config,'attempt-usage')).leaseToken,'lease');
});

test('pending pause intent uses stopped handshake and is preserved in the event',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-pause-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  await writeJournal(config,{attemptId:'attempt-pause',taskId:'task-pause',leaseToken:'lease',phase:'running',pid:2147483647,marker:'fixture-supervisor-marker-123456',identity:{startTime:'gone',pgid:2147483647},stopIntent:{reason:'pause'}});
  const calls=[];await recoverJournals(config,{event:async body=>calls.push(body),recover:async()=>assert.fail('must preserve stop intent')},{error(){}});
  assert.equal(calls[0].type,'stopped');assert.equal(calls[0].data.reason,'pause');
});

test('an unresolved worker lock blocks a second owner and can be released',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-worker-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  const release=await acquireNodeLock(config);await assert.rejects(acquireNodeLock(config),/already owns/);await release();const releaseAgain=await acquireNodeLock(config);await releaseAgain();
});

test('an absent unique marker never authorizes killing a matching PID',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-marker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'},identity=await identifyProcess(process.pid);assert.ok(identity);
  await writeJournal(config,{attemptId:'attempt-marker',taskId:'task-marker',leaseToken:'lease',phase:'running',pid:process.pid,marker:'',identity:{startTime:identity.startTime,pgid:identity.pgid}});
  const original=process.kill,signals=[];process.kill=(pid,signal)=>{signals.push({pid,signal});if(signal===0){const error=new Error('No such process');error.code='ESRCH';throw error}return true};
  try{const reports=[];await recoverJournals(config,{recover:async body=>reports.push(body)},{error(){}});assert.equal(reports[0].outcome,'unknown');assert.deepEqual(signals,[])}finally{process.kill=original}
});

test('owned orphan process group is stopped even when pending usage replay fails',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-orphan-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'},marker=`fixture-orphan-${Date.now()}`;
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',marker],{cwd:root,detached:true,stdio:'ignore'});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}});
  const closed=new Promise(resolve=>child.once('close',resolve));
  const identity=await new Promise((resolve,reject)=>{child.once('error',reject);const poll=async()=>{const found=await identifyProcess(child.pid);if(found?.command.includes(marker))resolve(found);else if(child.exitCode!==null)reject(new Error('fixture process exited'));else setTimeout(poll,20)};void poll()});
  const record={attemptId:'attempt-orphan',taskId:'task-orphan',leaseToken:'lease-fixture',phase:'running',pid:child.pid,marker,identity:{startTime:identity.startTime,pgid:identity.pgid},usageEvents:[{eventId:'pending-usage',inputTokens:5,outputTokens:1}]};
  await writeJournal(config,record);const reports=[];const blocked=await recoverJournals(config,{event:async()=>{throw new Error('API unavailable')},recover:async value=>reports.push(value)},{error(){}});
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('orphan process group was not stopped')),2000))]);
  assert.deepEqual([...blocked],['task-orphan']);assert.equal(reports[0].outcome,'unknown');assert.equal((await readJournal(config,'attempt-orphan')).phase,'running');
});

test('concurrent journal writes preserve invocation order and latest usage sequence',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-serial-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  await Promise.all(Array.from({length:40},(_,sequence)=>writeJournal(config,{attemptId:'attempt-serial',taskId:'task-serial',phase:'running',usageSequence:sequence})));
  assert.equal((await readJournal(config,'attempt-serial')).usageSequence,39);
});

test('journal queue is installed before slow directory preparation and snapshots records at call time',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-journal-slow-mkdir-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'node.json'),worktreesDir:path.join(root,'trees'),nodeId:'node-test'};
  let enteredResolve,releaseResolve;const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>releaseResolve=resolve);
  const fsImpl={mkdir:async(...args)=>{enteredResolve();await gate;return fs.mkdir(...args)},chmod:(...args)=>fs.chmod(...args),open:(...args)=>fs.open(...args),rename:(...args)=>fs.rename(...args)};
  const first=writeJournal(config,{attemptId:'attempt-slow',phase:'running',usageSequence:1},{fsImpl});await entered;
  const mutable={attemptId:'attempt-slow',phase:'running',usageSequence:2},second=writeJournal(config,mutable);mutable.usageSequence=99;
  releaseResolve();await Promise.all([first,second]);assert.equal((await readJournal(config,'attempt-slow')).usageSequence,2);
});
