import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';

test('config requires explicit project mappings and resolves token from environment', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'node-config-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'node.json');
  await fs.writeFile(file,JSON.stringify({serverUrl:'http://127.0.0.1:8768',projects:{p:{repoPath:dir,baseBranch:'main'}},tools:{codex:{command:'/opt/codex'}}}));await fs.chmod(file,0o600);
  const config=await loadConfig(file,{GAS_TOWN_NODE_TOKEN:'a-very-long-fixture-node-token'});
  assert.equal(config.token,'a-very-long-fixture-node-token');assert.equal(config.projects.p.repoPath,dir);assert.equal(config.codex.command,'/opt/codex');
});

test('config rejects insecure remote server and missing token',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'node-config-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'node.json');await fs.writeFile(file,JSON.stringify({serverUrl:'https://console.example',projects:{},tools:{}}));await fs.chmod(file,0o600);
  await assert.rejects(loadConfig(file,{}),/token/i);
});
