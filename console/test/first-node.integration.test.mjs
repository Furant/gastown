import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { AgentRunner } from '../node/runner.mjs';
import { WorkerClient } from '../node/client.mjs';
import { buildNodeSetupCommand } from '../web/onboarding.mjs';

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const execFileAsync = promisify(execFile);
function runInteractiveCli(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 10000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    setTimeout(() => child.stdin.end(options.input), 25);
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (status, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status, signal, stdout, stderr }); } });
  });
}

test('first local node can bootstrap from an empty project config through pairing, sync, and review', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'console-first-node-'));
  const repo = join(dir, 'repo'), worktreesDir = join(dir, 'worktrees'), configPath = join(dir, 'node-config.json');
  await mkdir(repo); await mkdir(worktreesDir);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'README.md'), 'fixture base\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture base');

  const fixtureCli = join(dir, 'fixture-codex');
  await writeFile(fixtureCli, `#!/usr/bin/env node
const readOnly=process.argv.includes('read-only');
console.log(JSON.stringify({type:'turn.completed',turn_id:readOnly?'plan-turn':'execute-turn',usage:{input_tokens:4,output_tokens:2}}));
if(!readOnly){require('node:fs').writeFileSync('README.md','fixture task change');require('node:fs').writeFileSync('added.txt','fixture output')}
const text=readOnly?JSON.stringify({summary:'Implement the requested fixture change',steps:[{title:'Update README',acceptance:'README contains the fixture change'}]}):'Fixture execution complete';
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`, { mode: 0o700 });

  const db = await createDatabase({ dataDir: ':memory:' }), app = await createApp({ db });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie, csrf;
  const device = randomBytes(32).toString('hex');
  const runners = [];
  t.after(async () => { await Promise.allSettled(runners.map(runner => runner.shutdown())); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await db.close(); await rm(dir, { recursive: true, force: true }); });
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', origin: base, 'x-local-device': device, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error?.message || ''}`); return { data: result.data, headers: response.headers };
  }
  const boot = await api('/auth/bootstrap', { organization: 'First node fixture', name: 'Fixture owner', email: 'first-node@example.test', password: randomBytes(24).toString('hex') });
  cookie = boot.headers.get('set-cookie').split(';')[0]; csrf = boot.data.csrfToken;

  // Start with the exact state that caused the onboarding dead end: no projects are mapped yet.
  const node = (await api('/nodes', { name: 'This computer', visibility: 'private' })).data;
  const token = node.token;
  const config = { serverUrl: base, projects: {}, worktreesDir, tools: { codex: { command: fixtureCli } }, preservedSetting: 'keep-me' };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).projects, {});
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  // Pair via the real CLI. The code is passed through stdin, and no paid provider is contacted.
  const pairing = (await api(`/nodes/${node.id}/pairing`, {})).data;
  const cliPath = join(dirname(dirname(new URL(import.meta.url).pathname)), 'node', 'index.mjs');
  const commandPaths={consoleDir:dirname(dirname(cliPath)),configPath};
  const pairRun = await runInteractiveCli('/bin/bash', ['-c',buildNodeSetupCommand({...commandPaths,mode:'pair'})], { cwd:dir, input: pairing.code + '\n', env: { ...process.env, GAS_TOWN_NODE_TOKEN: token, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000 });
  assert.equal(pairRun.status, 0, `${pairRun.stderr}\n${pairRun.stdout}`);
  assert.match(pairRun.stdout, /paired successfully/i);
  assert.ok(!pairRun.stdout.includes(token) && !pairRun.stderr.includes(token));

  // A config with zero mappings now creates a private local project bound to the paired node.
  const project = (await api('/projects', { name: 'Local fixture repo', repoType: 'local', localPath: repo, localNodeId: node.id, baseBranch: 'main', visibility: 'private' })).data;
  assert.equal(project.repoType, 'local'); assert.equal(project.localNodeId, node.id);

  // Sync through the real CLI and verify restrictive permissions plus preservation/backup behavior.
  const syncRun = await execFileAsync('/bin/bash', ['-c',buildNodeSetupCommand({...commandPaths,mode:'sync-config'})], { cwd:dir, encoding: 'utf8', env: { ...process.env, GAS_TOWN_NODE_TOKEN: token, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000 });
  assert.ok(!syncRun.stdout.includes(token) && !syncRun.stderr.includes(token));
  const synced = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(synced.projects[project.id].repoPath, await realpath(repo));
  assert.equal(synced.projects[project.id].baseBranch, 'main');
  assert.equal(synced.preservedSetting, 'keep-me'); assert.equal(Object.hasOwn(synced,'token'),false); assert.equal(Object.hasOwn(synced,'nodeId'),false);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const backupDir = join(dir, '.gastown-node-config-backups');
  const backups = await import('node:fs/promises').then(fs => fs.readdir(backupDir));
  assert.equal(backups.length, 1);
  assert.equal((await stat(join(backupDir, backups[0]))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(backupDir, backups[0]), 'utf8')).projects && Object.keys(JSON.parse(await readFile(join(backupDir, backups[0]), 'utf8')).projects).length, 0);

  // --check discovers a deterministic fixture Codex model cache and authenticates without claiming tasks.
  const codexHome = join(dir, 'codex-home'); await mkdir(codexHome);
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify([{ slug: 'fixture-codex', display_name: 'Fixture Codex', supported_reasoning_levels: [{ effort: 'high' }] }]));
  const checkRun = await execFileAsync('/bin/bash', ['-c',buildNodeSetupCommand({...commandPaths,mode:'check'})], { cwd:dir, encoding: 'utf8', env: { ...process.env, GAS_TOWN_NODE_TOKEN: token, CODEX_HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10000 });
  assert.match(checkRun.stdout, /codex: OK \(1 supported models\)/);
  assert.ok(!checkRun.stdout.includes(token) && !checkRun.stderr.includes(token));

  const caps = { tools: [{ tool: 'codex', models: [{ id: 'fixture-codex', name: 'Fixture Codex', modes: ['high'], nativeByMode: { high: 'fixture-codex' } }] }] };
  const client = new WorkerClient({ serverUrl: base, token });
  const foreign = (await api('/nodes', { name: 'Unpaired other computer', visibility: 'private' })).data;
  const foreignClient = new WorkerClient({ serverUrl: base, token: foreign.token }); await foreignClient.heartbeat(caps);
  const connection = (await api('/connections', { name: 'Fixture Codex', nodeId: node.id, tool: 'codex', visibility: 'private', projectIds: [project.id], model: 'fixture-codex', mode: 'high', allowedModels: ['fixture-codex'], allowOverride: true, maxConcurrency: 1 })).data;
  const task = (await api('/tasks', { title: 'Run a first local task', description: 'Update the fixture README and leave it for local review.', projectId: project.id, connectionId: connection.id })).data;
  const runner = new AgentRunner({ config: { ...synced, configPath, nodeId:node.id, codex: synced.tools.codex, projects: synced.projects }, capabilities: { tools: { codex: { models: caps.tools[0].models } } }, client, logger: { error() {} } }); runners.push(runner);
  await client.heartbeat(caps);
  const planJob = (await client.poll({ capacity: 1 })).jobs[0];
  assert.ok(planJob); assert.equal(planJob.repoType, 'local'); assert.equal(planJob.localNodeId, node.id); assert.equal(planJob.localPath, repo);
  await runner.run(planJob);
  await api(`/tasks/${task.id}/approve`, { allowPush: false, allowPR: false });
  assert.equal((await foreignClient.poll({ capacity: 1 })).jobs.length, 0, 'unselected unpaired node cannot claim a local task');
  await runner.run((await client.poll({ capacity: 1 })).jobs[0]);
  const detail = (await api(`/tasks/${task.id}`)).data;
  assert.equal(detail.status, 'awaiting_review');
  assert.ok(detail.localReview.worktreePath.startsWith(await realpath(worktreesDir)));
  assert.match(detail.localReview.diff, /fixture task change/);
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'fixture base\n', 'the original project checkout remains untouched');
  assert.match(await readFile(join(detail.localReview.worktreePath, 'README.md'), 'utf8'), /fixture task change/);
  const accepted = (await api(`/tasks/${task.id}/review`, { decision: 'accept', expectedGeneration: detail.reviewGeneration || 0 })).data;
  assert.equal(accepted.status, 'completed');
});
