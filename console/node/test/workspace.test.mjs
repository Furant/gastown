import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, ensureWorktree, taskBranch, makeCheckpoint } from '../workspace.mjs';

async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-node-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (args) => import('node:child_process').then(({ execFileSync }) => execFileSync('git', args, { cwd: root, stdio: 'ignore' }));
  run(['init', '-q']); run(['config', 'user.email', 'test@example.test']); run(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n'); run(['add', 'README.md']); run(['commit', '-qm', 'init']);
  return root;
}

test('a task uses a stable per-task worktree and keeps its uncommitted files on resume', async t => {
  const root = await repo(t), config = { projects: { p1: { repoPath: root, baseBranch: 'main' } } };
  const project = await resolveProject(config, 'p1');
  const first = await ensureWorktree(project, 'attempt-1');
  await fs.writeFile(path.join(first.path, 'draft.txt'), 'important uncommitted work');
  const resumed = await ensureWorktree(project, 'attempt-1');
  assert.equal(resumed.path, first.path);
  assert.equal(await fs.readFile(path.join(resumed.path, 'draft.txt'), 'utf8'), 'important uncommitted work');
  assert.equal(resumed.branch, taskBranch('attempt-1'));
});

test('project ids resolve only through explicit local mappings', async t => {
  const root = await repo(t);
  await assert.rejects(resolveProject({ projects: { p1: { repoPath: root, baseBranch: 'main' } } }, '../outside'), /not mapped/i);
  await assert.rejects(resolveProject({ projects: { p1: { repoPath: '/private/nonexistent', baseBranch: 'main' } } }, 'p1'), /project repository/i);
});

test('checkpoint reports task branch and dirty state without exposing local absolute paths', async t => {
  const root = await repo(t), project = await resolveProject({ projects: { p: { repoPath: root, baseBranch: 'main' } } }, 'p');
  const worktree = await ensureWorktree(project, 'run-7');
  await fs.writeFile(path.join(worktree.path, 'change.txt'), 'change');
  const snapshot = await makeCheckpoint(worktree);
  assert.equal(snapshot.branch, taskBranch('run-7'));
  assert.equal(snapshot.dirty, true);
  assert.ok(!JSON.stringify(snapshot).includes(root));
  assert.match(snapshot.worktree, /^node-worktrees\//);
});

test('in-place workspace uses the selected branch and preserves all existing changes', async t => {
  const root = await repo(t), project = await resolveProject({ projects: { p: { repoPath: root, baseBranch: 'main' } } }, 'p');
  await fs.writeFile(path.join(root, 'README.md'), 'staged and unstaged');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), 'unstaged too');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'keep');
  const { ensureInPlaceWorkspace, makeCheckpoint } = await import('../workspace.mjs');
  const workspace = await ensureInPlaceWorkspace(project, 'main');
  assert.equal(workspace.path, await fs.realpath(root));
  assert.equal(workspace.branch, 'main');
  assert.equal(workspace.mode, 'in_place');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'unstaged too');
  assert.equal(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8'), 'keep');
  const checkpoint = await makeCheckpoint(workspace);
  assert.equal(checkpoint.workspaceMode, 'in_place');
  assert.equal(checkpoint.branch, 'main');
  assert.equal(JSON.stringify(checkpoint).includes(root), false);
});

test('in-place workspace switches a clean repo to selected branch but refuses a dirty switch', async t => {
  const root = await repo(t), { execFileSync } = await import('node:child_process');
  execFileSync('git', ['branch', 'feature'], { cwd: root });
  execFileSync('git', ['switch', 'feature'], { cwd: root });
  const project = await resolveProject({ projects: { p: { repoPath: root, baseBranch: 'main' } } }, 'p');
  const { ensureInPlaceWorkspace } = await import('../workspace.mjs');
  const switched = await ensureInPlaceWorkspace(project, 'main');
  assert.equal(switched.branch, 'main');
  execFileSync('git', ['switch', 'feature'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), 'dirty');
  await assert.rejects(ensureInPlaceWorkspace(project, 'main'), /clean/i);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'feature');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'dirty');
});

test('clean branch switch refuses to overwrite an ignored local file tracked on target', async t => {
  const root = await repo(t), { execFileSync } = await import('node:child_process');
  await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'ignore local env'], { cwd: root });
  execFileSync('git', ['branch', 'target'], { cwd: root }); execFileSync('git', ['switch', 'target'], { cwd: root });
  await fs.writeFile(path.join(root, '.env'), 'committed target contents');
  execFileSync('git', ['add', '-f', '.env'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'track env on target'], { cwd: root });
  execFileSync('git', ['switch', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, '.env'), 'private ignored contents');
  const project = await resolveProject({ projects: { p: { repoPath: root, baseBranch: 'target' } } }, 'p');
  const { ensureInPlaceWorkspace } = await import('../workspace.mjs');
  await assert.rejects(ensureInPlaceWorkspace(project, 'target'));
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'main');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'private ignored contents');
});
