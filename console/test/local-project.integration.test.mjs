import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { AgentRunner } from '../node/runner.mjs';
import { WorkerClient } from '../node/client.mjs';

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

test('paired local project executes in an inspectable local worktree and stays private to its device', { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'console-local-project-'));
  const repo = join(dir, 'repo'), worktreesDir = join(dir, 'worktrees');
  await mkdir(repo); await mkdir(worktreesDir);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'README.md'), 'fixture base\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture base');

  const fixtureCli = join(dir, 'fixture-codex');
  await writeFile(fixtureCli, `#!/usr/bin/env node
const readOnly=process.argv.includes('read-only');
const usage=readOnly?{input_tokens:12,output_tokens:3,cached_input_tokens:2}:{input_tokens:7,output_tokens:2};
console.log(JSON.stringify({type:'turn.completed',turn_id:readOnly?'plan-turn':'execute-turn',usage}));
if(!readOnly){require('node:fs').writeFileSync('README.md','reviewed task change');require('node:fs').writeFileSync('added.txt','new task file')}
const text=readOnly?JSON.stringify({summary:'Plan recorded usage',steps:[{title:'Implement',acceptance:'Fixture reports usage'}]}):'Fixture execution complete';
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`, { mode: 0o700 });

  const db = await createDatabase({ dataDir: ':memory:' }), app = await createApp({ db });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie, csrf;
  const device = randomBytes(32).toString('hex');
  const runnerList = [];
  t.after(async () => { await Promise.allSettled(runnerList.map(runner => runner.shutdown())); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await db.close(); await rm(dir, { recursive: true, force: true }); });
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', origin: base, 'x-local-device':device, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error?.message || ''}`); return { data: result.data, headers: response.headers };
  }
  const boot = await api('/auth/bootstrap', { organization: 'Usage fixture', name: 'Fixture owner', email: 'usage-owner@example.test', password: randomBytes(24).toString('hex') });
  cookie = boot.headers.get('set-cookie').split(';')[0]; csrf = boot.data.csrfToken;
  const node = (await api('/nodes', { name:'Own paired computer', visibility:'private', projectIds:[] })).data;
  const caps = { tools:[{tool:'codex',models:[{id:'fixture-codex',name:'Fixture Codex',modes:['high'],nativeByMode:{high:'fixture-codex'}}]}] };
  const client = new WorkerClient({serverUrl:base,token:node.token}); await client.heartbeat(caps);
  const pairing = (await api(`/nodes/${node.id}/pairing`,{})).data;
  await client.pair(pairing.code);
  const project = (await api('/projects',{name:'Local fixture repo',repoType:'local',localPath:repo,localNodeId:node.id,baseBranch:'main',visibility:'private'})).data;
  assert.equal(project.repoType,'local');
  const foreign = (await api('/nodes',{name:'Other machine',visibility:'private',projectIds:[]})).data;
  const foreignClient = new WorkerClient({serverUrl:base,token:foreign.token}); await foreignClient.heartbeat(caps);
  const connection = (await api('/connections', { name: 'Fixture Codex', nodeId: node.id, tool: 'codex', visibility: 'private', projectIds: [project.id], model: 'fixture-codex', mode: 'high', allowedModels: ['fixture-codex'], allowOverride: true, maxConcurrency: 1 })).data;
  const task = (await api('/tasks', { title: 'Measure actual CLI usage', description: 'Record structured provider usage for plan and execution', projectId: project.id, connectionId: connection.id })).data;
  const runner = new AgentRunner({ config: { nodeId: node.id, projects: { [project.id]: { repoPath: repo, baseBranch: 'main' } }, worktreesDir, codex: { command: fixtureCli } }, capabilities: { tools: { codex: { models: caps.tools[0].models } } }, client, logger: { error() {} } }); runnerList.push(runner);

  const planJob = (await client.poll({capacity:1})).jobs[0];
  assert.equal(planJob.repoType,'local'); assert.equal(planJob.localNodeId,node.id);
  assert.equal(planJob.localPath,repo);
  await runner.run(planJob);
  await api(`/tasks/${task.id}/approve`,{allowPush:false,allowPR:false});
  assert.equal((await foreignClient.poll({capacity:1})).jobs.length,0);
  await runner.run((await client.poll({capacity:1})).jobs[0]);
  const detail = (await api(`/tasks/${task.id}`)).data;
  assert.equal(detail.status,'awaiting_review');
  assert.ok(detail.localReview.worktreePath.startsWith(await realpath(worktreesDir)));
  assert.ok(detail.localReview.files.some(file=>file.path==='README.md'));
  assert.ok(detail.localReview.files.some(file=>file.path==='added.txt'));
  assert.match(detail.localReview.diff,/reviewed task change/);
  const {readFile} = await import('node:fs/promises');
  assert.equal(await readFile(join(repo,'README.md'),'utf8'),'fixture base\n');
  assert.match(await readFile(join(detail.localReview.worktreePath,'README.md'),'utf8'),/reviewed task change/);
  const otherDevice = await fetch(base+'/api/v1/tasks/'+task.id,{headers:{cookie,'x-local-device':randomBytes(32).toString('hex')}});
  assert.equal(otherDevice.status,403,'another browser device must not read local review paths or diff');
});
