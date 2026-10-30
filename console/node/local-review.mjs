import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeOutput } from './output.mjs';

const exec = promisify(execFile);
const MAX_FILES = 32;
const MAX_FILE_PATH = 240;
const MAX_DIFF = 12_000;
const MAX_DIFF_BYTES = 12_000;
const MAX_WORKTREE_PATH = 2_048;
const MAX_REVIEW_BYTES = 28 * 1024;
const MAX_GIT_OUTPUT = 1024 * 1024;
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.env(?:$|[._-])|\.ssh(?:$|[\\/])|(?:id_(?:rsa|ed25519|ecdsa)|authorized_keys|known_hosts)(?:$|[\\/])|(?:secrets?|credentials?|tokens?|passwords?|auth)(?:$|[\\/.])|[^\\/]*(?:credential|secret|token|password|api[-_.]?key|private[-_.]?key)[^\\/]*|[^\\/]*\.(?:pem|p12|pfx|key|keystore|jks))(?=$|[\\/])/i;

function safeEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

async function git(cwd, args, { allowDiffExit = false } = {}) {
  try {
    const result = await exec('git', args, { cwd, env: safeEnvironment(), timeout: 5_000, maxBuffer: allowDiffExit ? MAX_DIFF_BYTES * 4 : MAX_GIT_OUTPUT, windowsHide: true, encoding: 'buffer' });
    return result.stdout;
  } catch (error) {
    if (allowDiffExit && error.code === 1 && Buffer.isBuffer(error.stdout)) return error.stdout;
    if (allowDiffExit && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return Buffer.from('[diff exceeds preview limit; open local worktree]\n');
    throw new Error('Unable to inspect local task changes');
  }
}

function parseStatus(raw) {
  const records = raw.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const status = record.slice(0, 2).trim() || '??';
    const name = record.slice(3);
    files.push({ path: name, status: fileStatus(status) });
    if (status.includes('R') || status.includes('C')) i++;
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function parseNameStatus(raw) {
  const records = raw.toString('utf8').split('\0').filter(Boolean), files = [];
  for (let i = 0; i + 1 < records.length; i += 2) files.push({ path: records[i + 1], status: fileStatus(records[i]) });
  return files;
}

function fileStatus(status) {
  if (status === '??') return 'untracked';
  if (status.includes('R')) return 'renamed';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'added';
  return 'modified';
}

async function symlinkPath(root, relative, baseline) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) return true;
  let current = root;
  for (const segment of relative.split(/[\\/]/)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) return true; }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  const indexed = await git(root, ['ls-files', '--stage', '-z', '--', relative]);
  if (indexed.toString('utf8').split('\0').some(record => record.startsWith('120000 '))) return true;
  const committed = await git(root, ['ls-tree', '-r', '-z', '--full-tree', baseline, '--', relative]);
  return committed.toString('utf8').split('\0').some(record => record.startsWith('120000 blob '));
}

function appendBounded(current, addition) {
  const room = Math.min(MAX_DIFF - current.length, MAX_DIFF_BYTES - Buffer.byteLength(current));
  if (room <= 0) return { value: current, truncated: true };
  let value = addition.slice(0, room);
  while (Buffer.byteLength(value) > room) value = value.slice(0, -1);
  const next = current + value;
  return { value: next, truncated: value.length < addition.length };
}

function prefixByBytes(value, limit) {
  let prefix = '';
  for (const character of value) {
    if (Buffer.byteLength(prefix + character) > limit) break;
    prefix += character;
  }
  return prefix;
}

export async function collectLocalReview({ worktreePath, project, workspaceMode } = {}) {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath) || Buffer.byteLength(worktreePath) > MAX_WORKTREE_PATH) throw new Error('Invalid local task worktree path');
  const root = await fs.realpath(worktreePath).catch(() => { throw new Error('Local task worktree is unavailable'); });
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Invalid local task worktree');
  const gitRoot = (await git(root, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if (await fs.realpath(gitRoot).catch(() => '') !== root) throw new Error('Local task worktree must be the Git repository root');
  let baseline = 'HEAD', baselineFiles = [];
  if (project?.baseBranch) {
    const branch = `refs/heads/${project.baseBranch}`;
    baseline = (await git(root, ['merge-base', 'HEAD', branch])).toString('utf8').trim();
    baselineFiles = parseNameStatus(await git(root, ['diff', '--name-status', '-z', '--no-renames', baseline, 'HEAD', '--']));
  }
  const worktreeFiles = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const fileMap = new Map(baselineFiles.map(file => [file.path, file]));
  for (const file of worktreeFiles) fileMap.set(file.path, file);
  const status = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const safeStatus = status.filter(file => !/[\u0000-\u001f\u007f-\u009f]/u.test(file.path));
  const visible = safeStatus.slice(0, MAX_FILES).map(file => ({ ...file, sourcePath: file.path, path: prefixByBytes(file.path, MAX_FILE_PATH) }));
  let diff = '', diffTruncated = false;
  for (const file of visible) {
    const relative = file.sourcePath;
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
    let addition;
    if (SENSITIVE_PATH.test(relative)) addition = `--- ${file.path} (${file.status})\n[content omitted for a sensitive path]\n`;
    else if (await symlinkPath(root, relative, baseline)) addition = `--- ${file.path} (${file.status})\n[symbolic link omitted]\n`;
    else {
      const tracked = file.status !== 'untracked' || (await git(root, ['ls-files', '--error-unmatch', '--', relative]).then(() => true).catch(() => false));
      const args = tracked
        ? ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', baseline, '--', relative]
        : ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', '/dev/null', relative];
      const raw = await git(root, args, { allowDiffExit: !tracked });
      const rendered = raw.toString('utf8');
      addition = rendered.includes('Binary files ') || rendered.includes('GIT binary patch')
        ? `--- ${file.path} (${file.status})\n[binary content omitted]\n`
        : rendered;
      if (rendered.includes('[diff exceeds preview limit')) diffTruncated = true;
    }
    addition = sanitizeOutput(addition);
    const bounded = appendBounded(diff, addition);
    diff = bounded.value;
    if (bounded.truncated) { diffTruncated = true; break; }
  }
  let filesTruncated = safeStatus.length !== status.length || safeStatus.length > MAX_FILES || safeStatus.some(file => Buffer.byteLength(file.path) > MAX_FILE_PATH);
  const result = { worktreePath: root, ...(workspaceMode ? { workspaceMode } : {}), ...(workspaceMode === 'in_place' ? { note: 'Review includes changes in the configured project directory, including pre-existing edits.' } : {}), files: visible.map(({ sourcePath, ...file }) => file), diff, diffTruncated, filesTruncated };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_REVIEW_BYTES && result.diff.length) {
    const nextLength = Math.floor(result.diff.length * 0.75);
    result.diff = prefixByBytes(result.diff, nextLength);
    result.diffTruncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_REVIEW_BYTES && result.files.length > 1) {
    result.files = result.files.slice(0, -1);
    result.filesTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_REVIEW_BYTES) throw new Error('Local review metadata exceeds the safe response limit');
  return result;
}
