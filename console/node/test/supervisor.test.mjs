import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { journalDirectory } from '../journal.mjs';

test('supervisor durably journals its unique process identity before launching a fixture command',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'node-supervisor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={configPath:path.join(root,'config.json'),worktreesDir:path.join(root,'trees'),nodeId:'fixture'};
  const record={attemptId:'supervised-attempt',taskId:'task-x',leaseToken:'lease-fixture',phase:'preparing'};
  const journal=path.join(journalDirectory(config),'supervised-attempt.json'),marker='unique-supervisor-fixture';
  const script=`const fs=require('fs');const j=JSON.parse(fs.readFileSync(${JSON.stringify(journal)},'utf8'));if(j.phase!=='running'||!j.identity||!j.marker)process.exit(3);process.stdout.write('launch-authorized');`;
  const env={...process.env,GT_NODE_CONFIG_JSON:JSON.stringify(config),GT_NODE_RECORD_JSON:JSON.stringify(record),GT_NODE_INVOCATION_JSON:JSON.stringify({command:process.execPath,args:['-e',script],cwd:root,env:{...process.env}})};
  const child=spawn(process.execPath,[new URL('../supervisor.mjs',import.meta.url).pathname,marker],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  const output=await new Promise((resolve,reject)=>{let value='';child.stdout.on('data',chunk=>value+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolve(value):reject(new Error(`supervisor exited ${code}`)))});
  assert.equal(output,'launch-authorized');const saved=JSON.parse(await fs.readFile(journal,'utf8'));assert.equal(saved.phase,'running');assert.equal(saved.marker,marker);assert.equal(saved.pid,child.pid);assert.equal(saved.identity.pgid,child.pid);
});
