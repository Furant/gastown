import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { WorkerClient } from '../node/client.mjs';
import { AgentRunner } from '../node/runner.mjs';

const cleanGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function eventually(fn, description, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await pause(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('HTTP control plane and real fixture processes preserve dirty work during stop-confirmed handoff', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'console-handoff-integration-'));
  const repo = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');
  await mkdir(repo);
  await mkdir(worktreesDir);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: cleanGitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Integration fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'README.md'), 'untouched source repository\n');
  git('add', 'README.md');
  git('commit', '-qm', 'fixture base');
  const codex = join(root, 'fixture-codex');
  const cursor = join(root, 'fixture-cursor');
  await writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('read-only')){
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Preserve task work while changing execution tools',steps:[{title:'Write task changes and test handoff',acceptance:'Original changes are present in the target worktree'}]})}}));
}else{
 fs.writeFileSync('source-dirty.txt','preserve this uncommitted content');
 console.log(JSON.stringify({type:'fixture.started'}));
 setInterval(()=>{},1000);
}
`, { mode: 0o700 });
  await writeFile(cursor, `#!/usr/bin/env node
const fs=require('node:fs');
if(fs.readFileSync('source-dirty.txt','utf8')!=='preserve this uncommitted content')process.exit(2);
fs.writeFileSync('target-result.txt','continued in the original worktree');
console.log(JSON.stringify({type:'result',result:'Preserved original changes; target fixture completed the approved task.'}));
`, { mode: 0o700 });

  const db = await createDatabase({ dataDir: ':memory:' });
  const app = await createApp({ db });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie, csrf;
  async function request(path, body, auth = true) {
    const headers = { 'content-type': 'application/json', origin: base };
    if (auth && cookie) headers.cookie = cookie;
    if (auth && csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(base + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    assert.ok(res.ok, `${path}: ${res.status} ${json.error?.message || ''}`);
    return { data: json.data, headers: res.headers };
  }
  const boot = await request('/auth/bootstrap', { organization: 'Integration', name: 'Fixture owner', email: 'owner@example.test', password: randomBytes(24).toString('hex') }, false);
  cookie = boot.headers.get('set-cookie').split(';')[0];
  csrf = boot.data.csrfToken;
  const project = (await request('/projects', { name: 'Fixture repo', repoUrl: 'https://github.com/fixture/repo.git', baseBranch: 'main', visibility: 'private' })).data;
  const node = (await request('/nodes', { name: 'Fixture node', visibility: 'private', projectIds: [project.id] })).data;
  const client = new WorkerClient({ serverUrl: base, token: node.token });
  const capabilities = { tools: [
    { tool: 'codex', models: [{ id: 'fixture-codex', name: 'Fixture Codex', modes: ['high'], nativeByMode: { high: 'fixture-codex' } }] },
    { tool: 'cursor', models: [{ id: 'fixture-cursor', name: 'Fixture Cursor', modes: ['high'], nativeByMode: { high: 'fixture-cursor-high' } }] }
  ] };
  await client.heartbeat(capabilities);
  const connection = async (tool, model) => (await request('/connections', { name: tool, nodeId: node.id, tool, projectIds: [project.id], model, mode: 'high', allowedModels: [model], allowOverride: true, maxConcurrency: 1, allowAutoFailover: false, visibility: 'private' })).data;
  const source = await connection('codex', 'fixture-codex');
  const target = await connection('cursor', 'fixture-cursor');
  const task = (await request('/tasks', { title: 'Handoff fixture', description: 'Keep uncommitted source work when moving to another tool', projectId: project.id, connectionId: source.id })).data;
  const runner = new AgentRunner({
    config: { projects: { [project.id]: { repoPath: repo, baseBranch: 'main' } }, worktreesDir, codex: { command: codex }, cursor: { command: cursor } },
    capabilities: { tools: Object.fromEntries(capabilities.tools.map(x => [x.tool, { models: x.models }])) }, client, stopTimeoutMs: 500,
    logger: { error() {} }
  });
  t.after(async () => {
    for (const id of runner.running.keys()) await runner.stop(id).catch(() => {});
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  const planning = (await client.poll({ capacity: 1 })).jobs[0];
  assert.equal(planning.kind, 'plan');
  await runner.run(planning);
  assert.equal((await request('/tasks/' + task.id)).data.status, 'awaiting_approval');
  assert.equal((await client.poll({ capacity: 1 })).jobs.length, 0, 'implementation must not start before human approval');
  await request('/tasks/' + task.id + '/approve', { allowPush: false, allowPR: false });
  const execution = (await client.poll({ capacity: 1 })).jobs[0];
  const sourceResult = runner.run(execution).then(value => ({ value }), error => ({ error }));
  await eventually(async () => {
    const session = runner.running.get(execution.attemptId);
    return session && await readFile(join(session.worktree.path, 'source-dirty.txt'), 'utf8').catch(() => '') === 'preserve this uncommitted content';
  }, 'source fixture dirty file');
  const sourcePath = runner.running.get(execution.attemptId).worktree.path;
  await request('/tasks/' + task.id + '/transfer', { connectionId: target.id });
  const beforeStop = await client.poll({ capacity: 1 });
  assert.equal(beforeStop.jobs.length, 0, 'target must not start while source is alive');
  assert.equal(beforeStop.cancellations[0].attemptId, execution.attemptId);
  await runner.stop(execution.attemptId);
  assert.ok((await sourceResult).error, 'stopped source must not report successful completion');
  const next = (await client.poll({ capacity: 1 })).jobs[0];
  assert.equal(next.tool, 'cursor');
  assert.equal(next.nativeModel, 'fixture-cursor-high');
  const result = await runner.run(next);
  assert.equal(result.worktree.path, sourcePath);
  assert.equal(await readFile(join(sourcePath, 'source-dirty.txt'), 'utf8'), 'preserve this uncommitted content');
  assert.equal(await readFile(join(sourcePath, 'target-result.txt'), 'utf8'), 'continued in the original worktree');
  assert.equal((await request('/tasks/' + task.id)).data.status, 'awaiting_review');
  assert.equal(git('status', '--porcelain'), '', 'main checkout must stay clean');
  assert.equal(git('branch', '--show-current'), 'main');
});
