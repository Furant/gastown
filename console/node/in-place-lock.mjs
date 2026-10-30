import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identifyProcess, readJournal, journalDirectory } from './journal.mjs';

const exec = promisify(execFile);
const held = new Map();
const guardOwners = new Map();
function definitelyGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function acquireGuard(file, assertWaitAllowed) {
  const guard = `${file}.guard`;
  let unreadableAttempts = 0;
  while (true) {
    assertWaitAllowed?.();
    const guardId = randomUUID(), identity = await identifyProcess(process.pid);
    if (!identity) throw new Error('Cannot verify this node process; refusing in-place lock operation');
    try {
      const handle = await fs.open(guard, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ guardId, pid: process.pid, startTime: identity.startTime })); await handle.sync(); }
      finally { await handle.close(); }
      guardOwners.set(guard, guardId);
      return async () => {
        if (guardOwners.get(guard) !== guardId) return;
        guardOwners.delete(guard);
        const current = await fs.readFile(guard, 'utf8').then(JSON.parse).catch(() => null);
        if (current?.guardId === guardId) await fs.unlink(guard).catch(error => { if (error.code !== 'ENOENT') throw error; });
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let existing;
    try { existing = JSON.parse(await fs.readFile(guard, 'utf8')); }
    catch {
      if (++unreadableAttempts < 8) { await delay(20); continue; }
      throw new Error('In-place lock recovery guard is unreadable; inspect it inside the repository Git directory before retrying');
    }
    const actual = await identifyProcess(existing.pid);
    if ((actual && actual.startTime === existing.startTime) || (!actual && !definitelyGone(existing.pid))) { await delay(50); continue; }
    throw new Error('In-place lock recovery guard owner is gone or ambiguous; inspect and manually remove the guard only after confirming no node process is using it');
  }
}
async function commonGitDir(project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: project.repoPath, env, timeout: 5000 });
  const value = stdout.trim();
  return await fs.realpath(path.resolve(project.repoPath, value));
}

function makeRelease(file, lockId) {
  held.set(file, lockId);
  return async () => {
    if (held.get(file) !== lockId) return;
    const releaseGuard = await acquireGuard(file);
    try {
      if (held.get(file) !== lockId) return;
      held.delete(file);
      const current = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.lockId === lockId) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally { await releaseGuard(); }
  };
}

export async function acquireInPlaceLock({ project, config, attemptId, assertWaitAllowed }) {
  const gitDir = await commonGitDir(project), file = path.join(gitDir, 'gastown-console-in-place.lock');
  const lockId = randomUUID(), owner = await identifyProcess(process.pid);
  if (!owner) throw new Error('Cannot verify this node process; refusing in-place execution');
  const lock = { version: 1, lockId, attemptId, journalPath: journalDirectory(config), pid: process.pid, startTime: owner.startTime, pgid: owner.pgid };
  while (true) {
    assertWaitAllowed?.();
    const releaseGuard = await acquireGuard(file, assertWaitAllowed);
    let wait = false;
    try {
      let existing;
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') existing = null; else throw new Error('In-place repository lock is unreadable; inspect the lock inside the repository Git directory before retrying'); }
      if (!existing) {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(lock)); await handle.sync(); }
        finally { await handle.close(); }
        return makeRelease(file, lockId);
      }
      const actual = await identifyProcess(existing.pid);
      if ((actual && actual.startTime === existing.startTime) || (!actual && !definitelyGone(existing.pid))) wait = true;
      if (!wait) {
        let journal;
        if (typeof existing.attemptId === 'string' && typeof existing.journalPath === 'string') {
          const journalConfig = { configPath: path.join(path.dirname(path.dirname(existing.journalPath)), 'placeholder'), journalNamespace: path.basename(existing.journalPath) };
          journal = await readJournal(journalConfig, existing.attemptId).catch(() => null);
        }
        if (journal?.phase !== 'terminal') throw new Error('A previous in-place task has an uncertain stop state. Keep this repository locked and resolve its node journal before retrying.');
        const latest = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        if (latest?.lockId === existing.lockId) {
          await fs.unlink(file);
          const handle = await fs.open(file, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(lock)); await handle.sync(); }
          finally { await handle.close(); }
          return makeRelease(file, lockId);
        }
      }
    } finally {
      await releaseGuard();
    }
    await delay(wait ? 150 : 50);
  }
}
