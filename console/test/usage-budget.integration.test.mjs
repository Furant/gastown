import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { AgentRunner } from '../node/runner.mjs';
import { WorkerClient } from '../node/client.mjs';

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

test('real fixture CLI usage drains before terminal events and recorded budget gates execution claims', { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'console-usage-budget-'));
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
const text=readOnly?JSON.stringify({summary:'Plan recorded usage',steps:[{title:'Implement',acceptance:'Fixture reports usage'}]}):'Fixture execution complete';
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`, { mode: 0o700 });

  const db = await createDatabase({ dataDir: ':memory:' }), app = await createApp({ db });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie, csrf;
  const runnerList = [];
  t.after(async () => { await Promise.allSettled(runnerList.map(runner => runner.shutdown())); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await db.close(); await rm(dir, { recursive: true, force: true }); });
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error?.message || ''}`); return { data: result.data, headers: response.headers };
  }
  const boot = await api('/auth/bootstrap', { organization: 'Usage fixture', name: 'Fixture owner', email: 'usage-owner@example.test', password: randomBytes(24).toString('hex') });
  cookie = boot.headers.get('set-cookie').split(';')[0]; csrf = boot.data.csrfToken;
  const project = (await api('/projects', { name: 'Usage fixture repo', repoUrl: 'https://github.com/fixture/usage.git', baseBranch: 'main', visibility: 'private' })).data;
  const node = (await api('/nodes', { name: 'Fixture node', visibility: 'private', projectIds: [project.id] })).data;
  const caps = { tools: [{ tool: 'codex', models: [{ id: 'fixture-codex', name: 'Fixture Codex', modes: ['high'], nativeByMode: { high: 'fixture-codex' } }] }] };
  const client = new WorkerClient({ serverUrl: base, token: node.token }); await client.heartbeat(caps);
  const connection = (await api('/connections', { name: 'Fixture Codex', nodeId: node.id, tool: 'codex', visibility: 'private', projectIds: [project.id], model: 'fixture-codex', mode: 'high', allowedModels: ['fixture-codex'], allowOverride: true, maxConcurrency: 1 })).data;
  const task = (await api('/tasks', { title: 'Measure actual CLI usage', description: 'Record structured provider usage for plan and execution', projectId: project.id, connectionId: connection.id })).data;
  const runner = new AgentRunner({ config: { nodeId: node.id, projects: { [project.id]: { repoPath: repo, baseBranch: 'main' } }, worktreesDir, codex: { command: fixtureCli } }, capabilities: { tools: { codex: { models: caps.tools[0].models } } }, client, logger: { error() {} } }); runnerList.push(runner);

  const planJob = (await client.poll({ capacity: 1 })).jobs[0]; assert.equal(planJob.kind, 'plan');
  const planned = await runner.run(planJob); assert.equal(planned.status, 'plan_ready');
  await api(`/projects/${project.id}/budget`, { enabled: true, maxRunsPerDay: 1 }, 'PUT');
  await api(`/tasks/${task.id}/approve`, { allowPush: false, allowPR: false });
  assert.equal((await client.poll({ capacity: 1 })).jobs.length, 0, 'budget blocks the approved execution claim after the planning run');
  assert.match((await api('/tasks')).data.find(item => item.id === task.id).budgetBlockReason, /run limit/i);

  await api(`/projects/${project.id}/budget`, { enabled: false, maxRunsPerDay: 1 }, 'PUT');
  const executionJob = (await client.poll({ capacity: 1 })).jobs[0]; assert.equal(executionJob.kind, 'execute');
  const result = await runner.run(executionJob); assert.equal(result.status, 'completed');
  const usage = (await api(`/usage?projectId=${project.id}`)).data;
  assert.equal(usage.inputTokens, 19); assert.equal(usage.outputTokens, 5); assert.equal(usage.cachedInputTokens, 2);
  assert.equal(usage.runCount, 2); assert.equal(usage.recordedCostMicros, null); assert.equal(usage.costCoverage.unknownRuns, 2);
});
