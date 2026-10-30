import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireInPlaceLock } from '../in-place-lock.mjs';
import { identifyProcess, journalDirectory, writeJournal } from '../journal.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'town-in-place-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); await fs.mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo }); await fs.writeFile(path.join(repo, 'README.md'), 'base');
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  const config = { configPath: path.join(dir, 'node-config.json'), journalNamespace: 'fixture' };
  return { repo, config, project: { repoPath: repo } };
}

test('same Git directory aliases serialize and a waiting attempt can cancel', async t => {
  const f = await fixture(t), alias = path.join(path.dirname(f.repo), 'alias'); await fs.symlink(f.repo, alias);
  const release = await acquireInPlaceLock({ ...f, attemptId: 'one' });
  let checks = 0;
  await assert.rejects(acquireInPlaceLock({ project: { repoPath: alias }, config: f.config, attemptId: 'two', assertWaitAllowed: () => { if (++checks > 2) throw new Error('cancelled'); } }), /cancelled/);
  await release();
  const next = await acquireInPlaceLock({ project: { repoPath: alias }, config: f.config, attemptId: 'two' });
  await next();
});

test('uncertain stale lock remains fenced; terminal journal permits safe recovery', async t => {
  const f = await fixture(t), gitDir = path.join(f.repo, '.git'), lockFile = path.join(gitDir, 'gastown-console-in-place.lock');
  const record = { version: 1, lockId: 'old-lock', attemptId: 'old-attempt', journalPath: journalDirectory(f.config), pid: 2147483647, startTime: 'gone', pgid: 2147483647 };
  await writeJournal(f.config, { attemptId: record.attemptId, taskId: 'old-task', phase: 'running', pid: 2147483647, identity: { startTime: 'gone', pgid: 2147483647 }, marker: 'fixture-supervisor-marker-123456' });
  await fs.writeFile(lockFile, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(acquireInPlaceLock({ ...f, attemptId: 'next' }), /uncertain stop state/i);
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).lockId, 'old-lock');
  await writeJournal(f.config, { attemptId: record.attemptId, taskId: 'old-task', phase: 'terminal' });
  const release = await acquireInPlaceLock({ ...f, attemptId: 'next' });
  await release();
});

test('concurrent stale-lock reclaimers cannot delete the winner lock', async t => {
  const f = await fixture(t), lockFile = path.join(f.repo, '.git', 'gastown-console-in-place.lock');
  const old = { version: 1, lockId: 'stale', attemptId: 'done-attempt', journalPath: journalDirectory(f.config), pid: 2147483647, startTime: 'gone', pgid: 2147483647 };
  await writeJournal(f.config, { attemptId: old.attemptId, taskId: 'done-task', phase: 'terminal' });
  await fs.writeFile(lockFile, JSON.stringify(old), { mode: 0o600 });
  const contenders = ['first', 'second'].map(id => acquireInPlaceLock({ ...f, attemptId: id }).then(release => ({ id, release })));
  const winner = await Promise.race(contenders);
  const loserPromise = contenders.find((_, index) => ['first', 'second'][index] !== winner.id);
  let loserReady = false;
  loserPromise.then(() => { loserReady = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(loserReady, false);
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).attemptId, winner.id);
  await winner.release();
  const loser = await loserPromise;
  assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).attemptId, loser.id);
  await loser.release();
});

test('dead recovery guard fails closed without replacing or removing another owner file', async t => {
  const f = await fixture(t), guard = path.join(f.repo, '.git', 'gastown-console-in-place.lock.guard');
  const record = { guardId: 'old-guard', pid: 2147483647, startTime: 'gone' };
  await fs.writeFile(guard, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(acquireInPlaceLock({ ...f, attemptId: 'next' }), /guard owner is gone or ambiguous/i);
  assert.equal(JSON.parse(await fs.readFile(guard, 'utf8')).guardId, 'old-guard');
});

test('a queued acquisition cancels while a live process owns the recovery guard', async t => {
  const f = await fixture(t), guard = path.join(f.repo, '.git', 'gastown-console-in-place.lock.guard');
  const identity = await identifyProcess(process.pid);
  await fs.writeFile(guard, JSON.stringify({ guardId: 'live-guard', pid: process.pid, startTime: identity.startTime }), { mode: 0o600 });
  await assert.rejects(acquireInPlaceLock({ ...f, attemptId: 'cancelled', assertWaitAllowed: () => { throw new Error('cancelled while queued'); } }), /cancelled while queued/);
  assert.equal(JSON.parse(await fs.readFile(guard, 'utf8')).guardId, 'live-guard');
  await assert.rejects(fs.access(path.join(f.repo, '.git', 'gastown-console-in-place.lock')));
});
