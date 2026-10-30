import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { AgentRunner } from '../node/runner.mjs';
import { WorkerClient } from '../node/client.mjs';
import { generateCheckpointKeys } from '../shared/checkpoint-crypto.mjs';

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('two authenticated nodes migrate encrypted dirty work only after source stop acknowledgment', { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'console-cross-node-'));
  const sourceRepo = join(dir, 'source-repo'), targetRepo = join(dir, 'target-repo');
  const sourceTrees = join(dir, 'source-worktrees'), targetTrees = join(dir, 'target-worktrees');
  await mkdir(sourceRepo); await mkdir(sourceTrees); await mkdir(targetTrees);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(sourceRepo, 'init', '-q', '-b', 'main');
  git(sourceRepo, 'config', 'user.name', 'Fixture');
  git(sourceRepo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(sourceRepo, 'README.md'), 'untouched source base\n');
  git(sourceRepo, 'add', 'README.md'); git(sourceRepo, 'commit', '-qm', 'fixture base');
  git(dir, 'clone', '-q', sourceRepo, targetRepo);
  const codex = join(dir, 'fixture-codex'), cursor = join(dir, 'fixture-cursor');
  await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('read-only'))console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Implement and preserve source changes',steps:[{title:'Preserve task changes',acceptance:'Changes survive a cross-node handoff'}]})}}));
else if(process.argv.at(-1).includes('DAG producer')){fs.writeFileSync('artifact.txt','independent child artifact');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DAG artifact ready'}}))}
else {fs.writeFileSync('work.txt','uncommitted source data');console.log(JSON.stringify({type:'fixture.started'}));setInterval(()=>{},1000)}
`, { mode: 0o700 });
  await writeFile(cursor, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.at(-1).includes('DAG validator')){if(!process.argv.at(-1).includes('DAG artifact ready'))process.exit(4);fs.writeFileSync('report.txt','dependency context verified');console.log(JSON.stringify({type:'result',result:'DAG validation ready'}));process.exit(0)}
if(fs.readFileSync('work.txt','utf8')!=='uncommitted source data')process.exit(3);
fs.writeFileSync('continued.txt','executed on target clone');
console.log(JSON.stringify({type:'result',result:'Cross-node continuation verified'}));
`, { mode: 0o700 });

  const db = await createDatabase({ dataDir: ':memory:' });
  const app = await createApp({ db });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie, csrf;
  const runners = [];
  t.after(async () => {
    await Promise.allSettled(runners.map(runner => runner.shutdown()));
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/v1' + path, {
      method,
      headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${result.error?.message || ''}`);
    return { data: result.data, headers: response.headers };
  }
  const boot = await api('/auth/bootstrap', { organization: 'Cross-node fixture', name: 'Fixture owner', email: 'owner@example.test', password: randomBytes(24).toString('hex') });
  cookie = boot.headers.get('set-cookie').split(';')[0]; csrf = boot.data.csrfToken;
  const project = (await api('/projects', { name: 'Fixture', repoUrl: 'https://github.com/fixture/repo.git', baseBranch: 'main', visibility: 'private' })).data;
  const caps = { tools: [
    { tool: 'codex', models: [{ id: 'fixture-codex', name: 'Fixture Codex', modes: ['high'], nativeByMode: { high: 'fixture-codex' } }] },
    { tool: 'cursor', models: [{ id: 'fixture-cursor', name: 'Fixture Cursor', modes: ['high'], nativeByMode: { high: 'fixture-cursor-high' } }] },
  ] };
  async function register(name) {
    const node = (await api('/nodes', { name, visibility: 'private' })).data;
    const keys = generateCheckpointKeys(), client = new WorkerClient({ serverUrl: base, token: node.token });
    await client.heartbeat(caps, keys.publicKey);
    return { node, keys, client };
  }
  const source = await register('Source machine'), target = await register('Target machine');
  await api('/projects/'+project.id,{nodeIds:[source.node.id,target.node.id]},'PATCH');
  async function connection(node, tool, model) {
    return (await api('/connections', { name: tool, nodeId: node.id, tool, visibility: 'private', projectIds: [project.id], model, mode: 'high', allowedModels: [model], allowOverride: true, maxConcurrency: 1 })).data;
  }
  const sourceConnection = await connection(source.node, 'codex', 'fixture-codex');
  const targetConnection = await connection(target.node, 'cursor', 'fixture-cursor');
  const task = (await api('/tasks', { title: 'Cross-node continuation', description: 'Continue uncommitted work on a second explicitly authorized node', projectId: project.id, connectionId: sourceConnection.id })).data;
  function makeRunner(entry, repoPath, worktreesDir) {
    const runner = new AgentRunner({
      config: { nodeId: entry.node.id, projects: { [project.id]: { repoPath, baseBranch: 'main' } }, worktreesDir, codex: { command: codex }, cursor: { command: cursor } },
      capabilities: { tools: Object.fromEntries(caps.tools.map(x => [x.tool, { models: x.models }])) },
      client: entry.client, checkpointKeys: entry.keys, stopTimeoutMs: 500, logger: { error() {} },
    }); runners.push(runner); return runner;
  }
  const sourceRunner = makeRunner(source, sourceRepo, sourceTrees), targetRunner = makeRunner(target, targetRepo, targetTrees);
  await sourceRunner.run((await source.client.poll({ capacity: 1 })).jobs[0]);
  await api('/tasks/' + task.id + '/approve', { allowPush: false, allowPR: false });
  const sourceJob = (await source.client.poll({ capacity: 1 })).jobs[0];
  const sourceResult = sourceRunner.run(sourceJob).then(value => ({ value }), error => ({ error }));
  await until(async () => {
    const session = sourceRunner.running.get(sourceJob.attemptId);
    return session && await readFile(join(session.worktree.path, 'work.txt'), 'utf8').catch(() => '') === 'uncommitted source data';
  }, 'source changes');
  await api('/tasks/' + task.id + '/transfer', { connectionId: targetConnection.id });
  assert.equal((await target.client.poll({ capacity: 1 })).jobs.length, 0, 'target must not execute before source has stopped');
  const cancellation = (await source.client.poll({ capacity: 0 })).cancellations[0];
  assert.equal(cancellation.handoff.targetNodeId, target.node.id);
  await sourceRunner.cancel(cancellation);
  assert.ok((await sourceResult).error);
  const targetJob = (await target.client.poll({ capacity: 1 })).jobs[0];
  assert.ok(targetJob.checkpoint?.checkpointId, 'target claim must reference the encrypted checkpoint');
  assert.equal((await api('/tasks/' + task.id)).data.status, 'running');
  const detail = JSON.stringify((await api('/tasks/' + task.id)).data);
  assert.equal(detail.includes('ciphertext'), false, 'user task details must not expose checkpoint payloads');
  const result = await targetRunner.run(targetJob);
  assert.equal(await readFile(join(result.worktree.path, 'work.txt'), 'utf8'), 'uncommitted source data');
  assert.equal(await readFile(join(result.worktree.path, 'continued.txt'), 'utf8'), 'executed on target clone');
  assert.notEqual(result.worktree.path, sourceRunner.running.get(sourceJob.attemptId)?.worktree?.path);
  assert.equal(git(sourceRepo, 'status', '--porcelain'), ''); assert.equal(git(targetRepo, 'status', '--porcelain'), '');
  assert.equal((await api('/tasks/' + task.id)).data.status, 'awaiting_review');

  const parent = (await api('/tasks', { title: 'Multi-agent workflow', description: 'Produce an independent artifact and validate its result with a second AI tool', projectId: project.id, connectionId: sourceConnection.id })).data;
  await sourceRunner.run((await source.client.poll({ capacity: 1 })).jobs[0]);
  await api('/tasks/' + parent.id + '/decompose', { children: [
    { key: 'build', title: 'DAG producer', description: 'Produce the independently reviewed artifact', connectionId: sourceConnection.id, dependsOn: [] },
    { key: 'validate', title: 'DAG validator', description: 'Validate the explicit upstream result context', connectionId: targetConnection.id, dependsOn: ['build'] },
  ] });
  assert.equal((await source.client.poll({ capacity: 1 })).jobs.length, 0, 'decomposed children still require parent approval');
  assert.equal((await target.client.poll({ capacity: 1 })).jobs.length, 0);
  await api('/tasks/' + parent.id + '/approve', { allowPush: false, allowPR: false });
  assert.equal((await target.client.poll({ capacity: 1 })).jobs.length, 0, 'dependent agent must wait for producer result');
  const build = (await source.client.poll({ capacity: 1 })).jobs[0];
  assert.notEqual(build.taskId, parent.id);
  assert.equal(build.title, 'DAG producer');
  const produced = await sourceRunner.run(build);
  const validate = (await target.client.poll({ capacity: 1 })).jobs[0];
  assert.equal(validate.title, 'DAG validator');
  assert.equal(validate.tool, 'cursor');
  assert.ok(validate.dependencyResults.some(item => (item.summary || item.result?.summary)?.includes('DAG artifact ready')));
  const validated = await targetRunner.run(validate);
  assert.notEqual(produced.worktree.path, validated.worktree.path);
  assert.equal(await readFile(join(validated.worktree.path, 'report.txt'), 'utf8'), 'dependency context verified');
  const workflow = (await api('/tasks/' + parent.id)).data;
  assert.equal(workflow.status, 'awaiting_review', 'all child results still require human review');
  assert.equal(workflow.children.length, 2);
  assert.ok(workflow.children.every(child => child.status === 'awaiting_review'));
});
