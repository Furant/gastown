import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWorktree } from '../workspace.mjs';
import { collectLocalReview } from '../local-review.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await fs.writeFile(path.join(root, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-qm', 'base');
  const worktree = path.join(root, 'task worktree'); git('worktree', 'add', '-q', '-b', 'console/task-local-review', worktree, 'main');
  return { root, worktree };
}

test('review summary reports bounded changed files and textual diff without touching the worktree', async t => {
  const { root, worktree } = await fixture(t);
  await fs.writeFile(path.join(worktree, 'README.md'), 'changed text\n');
  await fs.writeFile(path.join(worktree, 'new file.txt'), 'new content\n');
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
  const review = await collectLocalReview({ worktreePath: worktree });
  assert.equal(review.worktreePath, await fs.realpath(worktree));
  assert.deepEqual(review.files.map(file => file.path), ['new file.txt', 'README.md']);
  assert.match(review.diff, /changed text/); assert.match(review.diff, /new content/);
  assert.equal(review.diffTruncated, false); assert.equal(review.filesTruncated, false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }), before);
  assert.ok(root);
});

test('review diff includes committed task changes relative to the approved base branch', async t => {
  const { root, worktree } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await fs.writeFile(path.join(worktree, 'README.md'), 'committed task change\nAPI_KEY=fake-example-secret\n');
  await fs.writeFile(path.join(worktree, 'committed.txt'), 'committed file\n');
  git('add', '.'); git('commit', '-qm', 'agent commit');
  const review = await collectLocalReview({ worktreePath: worktree, project: { baseBranch: 'main' } });
  assert.ok(review.files.some(file => file.path === 'README.md'));
  assert.ok(review.files.some(file => file.path === 'committed.txt'));
  assert.match(review.diff, /committed task change/);
  assert.match(review.diff, /committed file/);
  assert.equal(review.diff.includes('fake-example-secret'), false);
  assert.ok(root);
});

test('review summary omits credential-like file content and symbolic-link targets', async t => {
  const { worktree } = await fixture(t);
  await fs.writeFile(path.join(worktree, '.env'), 'FAKE_REVIEW_CANARY=must-not-leak');
  await fs.symlink('/etc/passwd', path.join(worktree, 'external-link'));
  const review = await collectLocalReview({ worktreePath: worktree });
  assert.ok(review.files.some(file => file.path === '.env'));
  assert.ok(review.diff.includes('content omitted for a sensitive path'));
  assert.equal(review.diff.includes('must-not-leak'), false);
  assert.equal(review.diff.includes('root:'), false);
  assert.ok(review.diff.includes('symbolic link omitted'));
});

test('review summary omits binary file contents', async t => {
  const { worktree } = await fixture(t);
  await fs.writeFile(path.join(worktree, 'fixture.bin'), Buffer.from([0, 1, 2, 0, 65]));
  const review = await collectLocalReview({ worktreePath: worktree });
  assert.ok(review.diff.includes('binary content omitted'));
  assert.equal(review.diff.includes('Binary files '), false);
});

test('review summary truncates file and diff output to the protocol bounds', async t => {
  const { worktree } = await fixture(t);
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(worktree, `change-${String(i).padStart(2, '0')}.txt`), 'x'.repeat(1000));
  const review = await collectLocalReview({ worktreePath: worktree });
  assert.equal(review.files.length, 32); assert.equal(review.filesTruncated, true);
  assert.ok(review.diff.length <= 12000); assert.equal(review.diffTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(review)) <= 28 * 1024);
});

test('invalid worktree paths are rejected before Git inspection', async () => {
  await assert.rejects(collectLocalReview({ worktreePath: '/missing/and/not/a/git/repository' }), /worktree/i);
});

test('review diff represents staged and committed deletions', async t => {
  const staged = await fixture(t);
  await fs.rm(path.join(staged.worktree, 'README.md'));
  execFileSync('git', ['add', '-u'], { cwd: staged.worktree });
  const stagedReview = await collectLocalReview({ worktreePath: staged.worktree });
  assert.ok(stagedReview.files.some(file => file.path === 'README.md' && file.status === 'deleted'));
  assert.match(stagedReview.diff, /base/);

  const committed = await fixture(t);
  await fs.rm(path.join(committed.worktree, 'README.md'));
  execFileSync('git', ['add', '-u'], { cwd: committed.worktree });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'delete base file'], { cwd: committed.worktree });
  const committedReview = await collectLocalReview({ worktreePath: committed.worktree, project: { baseBranch: 'main' } });
  assert.ok(committedReview.files.some(file => file.path === 'README.md' && file.status === 'deleted'));
  assert.match(committedReview.diff, /base/);
});

test('review summary skips filenames containing control characters', async t => {
  const { worktree } = await fixture(t);
  await fs.writeFile(path.join(worktree, 'line\nbreak.txt'), 'should not break review payload');
  const review = await collectLocalReview({ worktreePath: worktree });
  assert.deepEqual(review.files, []);
  assert.equal(review.filesTruncated, true);
  assert.equal(review.diff, '');
});
