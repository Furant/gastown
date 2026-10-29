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
