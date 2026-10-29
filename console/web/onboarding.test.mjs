import { randomBytes } from 'node:crypto';
const excludedToken = randomBytes(24).toString('hex');
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNodeConfig,
  escapeHTML,
  getLocalDeviceSecret,
  githubPrUrl,
  isAbsoluteNodePath,
  isControlPlaneUrlAllowed,
  nodeStatus,
  validateNodeConfig,
  nodeProjectIds,
  freshWorkspaceState,
  nodePairCommand,
  createSessionEpochGuard,
} from './onboarding.mjs';

test('builds a token-free node config from mapped projects and CLI paths', () => {
  const config = buildNodeConfig({
    serverUrl: 'https://console.example.com/',
    projects: [{ id: 'p1', repoPath: '/work/repo', baseBranch: 'main' }],
    cliPaths: { codex: '/usr/local/bin/codex', cursor: '' },
    token: excludedToken,
  });
  assert.deepEqual(config, {
    serverUrl: 'https://console.example.com/',
    projects: { p1: { repoPath: '/work/repo', baseBranch: 'main' } },
    tools: { codex: { command: '/usr/local/bin/codex' } },
  });
  assert.equal(JSON.stringify(config).includes(excludedToken), false);
  assert.equal(validateNodeConfig(config).valid, true);
});

test('accepts an empty project map for first-node bootstrap but validates every supplied mapping', () => {
  const bootstrap = { serverUrl: 'https://console.example.com', projects: {}, tools: { codex: { command: '/usr/local/bin/codex' } } };
  assert.equal(validateNodeConfig(bootstrap).valid, true);
  assert.equal(validateNodeConfig({ ...bootstrap, projects: { p: { repoPath: 'relative', baseBranch: 'main' } } }).errors.includes('projects'), true);
  assert.equal(validateNodeConfig({ ...bootstrap, projects: { p: { repoPath: '/work/repo', baseBranch: '' } } }).errors.includes('projects'), true);
  for (const projects of [undefined, null, [], { p: null }, { p: [] }]) {
    const config = { ...bootstrap, projects };
    if (projects === undefined) delete config.projects;
    assert.equal(validateNodeConfig(config).errors.includes('projects'), true, `rejects ${String(projects)}`);
  }
});

test('normalizes node registration with no project checkbox controls to an empty project list', () => {
  assert.deepEqual(nodeProjectIds({ name: 'My laptop' }), []);
  assert.deepEqual(nodeProjectIds({ projectIds: ['project-1'] }), ['project-1']);
});

test('fresh workspace reset discards account-private state and retains only local device credential', () => {
  const secret = 'a'.repeat(64);
  const fresh = freshWorkspaceState({
    page: 'detail', detail: { diff: 'private account diff' },
    localProjectDraft: { localPath: '/private/repo' }, token: excludedToken,
    nodeSetup: { values: { cliPaths: { codex: '/private/codex' } } }, pairingCode: { code: 'private-code' },
    items: { projects: [{ localPath: '/private/repo' }] }, deviceSecret: secret,
  });
  assert.equal(fresh.deviceSecret, secret);
  assert.equal(fresh.user, null);
  assert.equal(fresh.detail, null);
  assert.equal(fresh.page, 'tasks');
  assert.equal(fresh.nodeSetup, null);
  assert.equal(fresh.pairingCode, null);
  assert.equal(fresh.localProjectDraft, null);
  assert.deepEqual(fresh.items, { projects: [], tasks: [], connections: [], nodes: [], members: [], teams: [], audit: [] });
});

test('pairing command prompts for the code instead of exposing it in argv', () => {
  const command = nodePairCommand();
  assert.match(command, /--pair$/);
  assert.equal(command.includes('CODE'), false);
});

test('session epoch guard rejects responses started before account state reset', () => {
  const guard = createSessionEpochGuard();
  const requestEpoch = guard.capture();
  guard.assertCurrent(requestEpoch);
  guard.advance();
  assert.throws(() => guard.assertCurrent(requestEpoch), /会话已切换/);
  assert.equal(guard.capture(), requestEpoch + 1);
});

test('allows HTTPS control planes and loopback HTTP only', () => {
  for (const url of ['https://console.example.com', 'http://localhost:8768', 'http://127.0.0.1:8768', 'http://[::1]:8768']) {
    assert.equal(isControlPlaneUrlAllowed(url), true, url);
  }
  for (const url of ['http://console.example.com', 'file:///tmp', 'https://user:pass@example.com', 'https://console.example.com/?token=x']) {
    assert.equal(isControlPlaneUrlAllowed(url), false, url);
  }
});

test('validates absolute paths and escapes values rendered in HTML previews', () => {
  assert.equal(isAbsoluteNodePath('/work/repo'), true);
  assert.equal(isAbsoluteNodePath('C:\\work\\repo'), true);
  assert.equal(isAbsoluteNodePath('relative/repo'), false);
  assert.equal(escapeHTML('<script x="1">&\'x\'</script>'), '&lt;script x=&quot;1&quot;&gt;&amp;&#39;x&#39;&lt;/script&gt;');
  const result = validateNodeConfig({ serverUrl: 'http://console.example.com', projects: { p: { repoPath: 'relative', baseBranch: 'main' } }, tools: {} });
  assert.deepEqual(new Set(result.errors), new Set(['serverUrl', 'projects', 'tools']));
});

test('maps unregistered nodes to pending and heartbeat nodes to online or offline', () => {
  assert.equal(nodeStatus({ status: 'offline' }), 'pending');
  assert.equal(nodeStatus({ status: 'waiting', onlineAt: '2026-01-01T00:00:00Z' }), 'pending');
  assert.equal(nodeStatus({ status: 'online', onlineAt: '2026-01-01T00:00:00Z' }), 'online');
  assert.equal(nodeStatus({ status: 'offline', onlineAt: '2026-01-01T00:00:00Z' }), 'offline');
  assert.equal(nodeStatus({ status: 'online', onlineAt: '2026-01-01T00:00:00Z', revokedAt: '2026-01-01T00:01:00Z' }), 'offline');
});

test('only accepts HTTPS GitHub PR URLs', () => {
  assert.equal(githubPrUrl('https://github.com/Furant/gastown/pull/42'), 'https://github.com/Furant/gastown/pull/42');
  for (const url of ['http://github.com/a/b/pull/1', 'https://evil.example/github.com', 'https://github.com.evil.example/a/b', 'https://user@github.com/a/b/pull/1', 'https://github.com/a/b/issues/1', 'not a URL']) {
    assert.equal(githubPrUrl(url), null, url);
  }
});

test('local device credential persists securely generated random bytes and reuses only valid values', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const cryptoApi = { getRandomValues: bytes => { bytes.fill(42); return bytes; } };
  const first = getLocalDeviceSecret(storage, cryptoApi);
  assert.equal(first.length, 64);
  assert.equal(getLocalDeviceSecret(storage, { getRandomValues: () => { throw new Error('must reuse'); } }), first);
  values.set('gastown.local-device.v1', 'invalid');
  assert.equal(getLocalDeviceSecret(storage, cryptoApi), first);
});
