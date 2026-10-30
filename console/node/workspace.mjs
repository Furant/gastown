import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function taskBranch(taskId) {
  if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) throw new Error('Invalid task identifier');
  return `console/task-${crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 12)}`;
}

async function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await exec('git', args, { cwd: root, env, timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true });
  return stdout.trim();
}

export async function resolveProject(config, projectId) {
  if (typeof projectId !== 'string' || !Object.hasOwn(config.projects || {}, projectId)) throw new Error('Project is not mapped on this node');
  const mapping = config.projects[projectId];
  if (!mapping || typeof mapping.repoPath !== 'string' || typeof mapping.baseBranch !== 'string' || !mapping.baseBranch.trim()) throw new Error('Invalid local project repository mapping');
  let repoPath;
  try { repoPath = await fs.realpath(mapping.repoPath); }
  catch { throw new Error('Project repository is unavailable on this node'); }
  const repo = await fs.stat(repoPath);
  if (!repo.isDirectory()) throw new Error('Project repository path is not a directory');
  const top = await git(repoPath, ['rev-parse', '--show-toplevel']);
  if (path.resolve(top) !== repoPath) throw new Error('Mapped project path is not the root of its Git repository');
  await git(repoPath, ['check-ref-format', '--branch', mapping.baseBranch]);
  await git(repoPath, ['rev-parse', '--verify', `refs/heads/${mapping.baseBranch}`]).catch(() => { throw new Error(`Mapped base branch is missing locally: ${mapping.baseBranch}`); });
  const worktreesDir = await fs.realpath(config.worktreesDir || path.join(os.homedir(), '.gastown-console', 'worktrees')).catch(async () => {
    const requested = config.worktreesDir || path.join(os.homedir(), '.gastown-console', 'worktrees');
    await fs.mkdir(requested, { recursive: true, mode: 0o700 });
    return fs.realpath(requested);
  });
  if (worktreesDir === repoPath || worktreesDir.startsWith(`${repoPath}${path.sep}`)) throw new Error('Worktree storage must be outside the source repository');
  return { id: projectId, repoPath, baseBranch: mapping.baseBranch, worktreesDir };
}

function taskFolder(project, taskId) {
  const repoKey = crypto.createHash('sha256').update(project.repoPath).digest('hex').slice(0, 16);
  const taskKey = crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 24);
  return path.join(project.worktreesDir, repoKey, taskKey);
}

export async function ensureWorktree(project, taskId, { mustBeNew = false, allowExistingCheckpoint = false } = {}) {
  const branch = taskBranch(taskId);
  const target = taskFolder(project, taskId);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (await fs.stat(target).then(x => x.isDirectory()).catch(() => false)) {
    if (mustBeNew && !allowExistingCheckpoint) throw new Error('Checkpoint target task already has a worktree; refusing unrelated restore or replay');
    const actualPath = await fs.realpath(target);
    if (actualPath !== target) throw new Error('Task worktree path resolves outside the configured worktree directory');
    const [top, actualBranch, commonDir] = await Promise.all([
      git(target, ['rev-parse', '--show-toplevel']),
      git(target, ['symbolic-ref', '--short', 'HEAD']),
      git(target, ['rev-parse', '--git-common-dir'])
    ]);
    const expectedCommonDir = await git(project.repoPath, ['rev-parse', '--git-common-dir']);
    if (path.resolve(top) !== target || actualBranch !== branch || path.resolve(target, commonDir) !== path.resolve(project.repoPath, expectedCommonDir)) throw new Error('Existing task worktree does not match the requested project and branch');
    return { path: target, branch, project, created: false, mode: 'worktree' };
  }
  if (await fs.lstat(target).then(() => true).catch(() => false)) throw new Error('Task worktree path exists and is not a directory');
  const branchExists = await git(project.repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true).catch(error => {
    if (error.code === 1) return false;
    throw new Error('Unable to check existing task branch');
  });
  if (mustBeNew && branchExists) throw new Error('Checkpoint target task branch already exists; refusing unrelated restore or replay');
  if (branchExists) await git(project.repoPath, ['worktree', 'add', target, branch]);
  else await git(project.repoPath, ['worktree', 'add', '-b', branch, target, project.baseBranch]);
  return { path: target, branch, project, created: true, mode: 'worktree' };
}

export async function ensureInPlaceWorkspace(project, selectedBranch) {
  if (typeof selectedBranch !== 'string' || !selectedBranch.trim() || selectedBranch !== project.baseBranch) throw new Error('Selected project branch does not match the configured node repository mapping');
  await git(project.repoPath, ['check-ref-format', '--branch', selectedBranch]);
  await git(project.repoPath, ['rev-parse', '--verify', `refs/heads/${selectedBranch}`]).catch(() => { throw new Error(`Selected branch is missing locally: ${selectedBranch}`); });
  const [top, current, status, unmerged] = await Promise.all([
    git(project.repoPath, ['rev-parse', '--show-toplevel']),
    git(project.repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(project.repoPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(project.repoPath, ['diff', '--name-only', '--diff-filter=U'])
  ]);
  if (path.resolve(top) !== project.repoPath) throw new Error('Mapped project path is not the root of its Git repository');
  if (!current) throw new Error('Local repository is detached; checkout the selected branch before running this task');
  if (unmerged) throw new Error('Local repository has unmerged paths; resolve them before running this task');
  if (current !== selectedBranch) {
    if (status) throw new Error(`Local repository has uncommitted changes; clean the working tree before switching from ${current} to ${selectedBranch}`);
    await git(project.repoPath, ['switch', '--no-overwrite-ignore', '--no-recurse-submodules', selectedBranch]);
  }
  return { path: project.repoPath, branch: selectedBranch, project, created: false, mode: 'in_place' };
}

export async function makeCheckpoint(worktree) {
  const [branch, status] = await Promise.all([
    git(worktree.path, ['symbolic-ref', '--short', 'HEAD']),
    git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all'])
  ]);
  if (branch !== worktree.branch) throw new Error('Task branch changed unexpectedly; refusing to checkpoint');
  if (worktree.mode === 'in_place') {
    const top = await git(worktree.path, ['rev-parse', '--show-toplevel']);
    if (path.resolve(top) !== worktree.project.repoPath) throw new Error('Local repository root changed unexpectedly; refusing to checkpoint');
    const opaque = crypto.createHash('sha256').update(worktree.project.repoPath).digest('hex').slice(0, 20);
    return { branch, worktree: `local-repository/${opaque}`, workspaceMode: 'in_place', dirty: Boolean(status) };
  }
  const relative = path.relative(worktree.project.worktreesDir, worktree.path);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Task worktree escaped its local storage');
  return { branch, worktree: `node-worktrees/${relative}`, workspaceMode: 'worktree', dirty: Boolean(status) };
}
