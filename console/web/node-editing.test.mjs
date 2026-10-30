import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeNodeEditProjectIds, nodeEditPatchBody, nodeEditProjectSelection } from './node-editing.mjs';

test('node edit preselects current grants and locks the bound local project', () => {
  const node = { id: 'node-a', projectIds: ['remote-a', 'local-a'] };
  const projects = [
    { id: 'remote-a', name: 'Remote A', repoType: 'git' },
    { id: 'remote-b', name: 'Remote B', repoType: 'git' },
    { id: 'local-a', name: 'Local A', repoType: 'local', localNodeId: 'node-a' },
    { id: 'local-b', name: 'Local B', repoType: 'local', localNodeId: 'node-b' },
  ];
  assert.deepEqual(nodeEditProjectSelection(node, projects), {
    options: [
      { id: 'remote-a', name: 'Remote A', selected: true, locked: false },
      { id: 'remote-b', name: 'Remote B', selected: false, locked: false },
      { id: 'local-a', name: 'Local A', selected: true, locked: true },
    ],
    retainedGrantIds: [],
  });
  assert.deepEqual(mergeNodeEditProjectIds(node, ['remote-b'], projects), ['remote-b', 'local-a']);
});

test('node edit preserves grants omitted from the project response', () => {
  const node = { id: 'node-a', projectIds: ['visible-a', 'hidden-grant'] };
  const selection = nodeEditProjectSelection(node, [{ id: 'visible-a', name: 'Visible A', repoType: 'git' }]);
  assert.deepEqual(selection.retainedGrantIds, ['hidden-grant']);
  assert.deepEqual(mergeNodeEditProjectIds(node, [], [{ id: 'visible-a', name: 'Visible A', repoType: 'git' }]), ['hidden-grant']);
});

test('node patch includes only editable metadata and leaves client command paths out', () => {
  const body = nodeEditPatchBody({
    name: 'Updated node', visibility: 'custom', memberIds: ['member-a'], projectIds: ['project-b'],
    consoleDir: '/private/repo', configPath: '/private/node-config.json', token: 'never-send',
  }, { id: 'node-a', projectIds: ['hidden-grant'] }, [{ id: 'project-b', repoType: 'git' }]);
  assert.deepEqual(body, {
    name: 'Updated node', visibility: 'custom', memberIds: ['member-a'],
    projectIds: ['project-b', 'hidden-grant'],
  });
});
