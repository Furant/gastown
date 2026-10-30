import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNodeSelection, projectNodePatchBody } from './project-nodes.mjs';

test('remote projects select from usable nodes; local project stays bound to its paired node', () => {
  const nodes = [
    { id: 'mine', ownerId: 'u1', pairedToThisDevice: true },
    { id: 'shared', ownerId: 'u2', visibility: 'team' },
    { id: 'private', ownerId: 'u2', visibility: 'private' },
    { id: 'revoked', ownerId: 'u1', revokedAt: '2026-10-30T00:00:00Z' },
  ];
  assert.deepEqual(projectNodeSelection({ repoType: 'remote', nodeIds: ['shared', 'revoked'] }, nodes, 'u1'), {
    options: [
      { id: 'mine', name: 'mine', selected: false, locked: false },
      { id: 'shared', name: 'shared', selected: true, locked: false },
    ], retainedNodeIds: ['revoked'],
  });
  assert.deepEqual(projectNodeSelection({ repoType: 'local', localNodeId: 'mine' }, nodes, 'u1'), {
    options: [{ id: 'mine', name: 'mine', selected: true, locked: true }], retainedNodeIds: [],
  });
});

test('project node patch only submits checked node IDs so unavailable grants can be removed', () => {
  assert.deepEqual(projectNodePatchBody({ nodeIds: [] }), {
    nodeIds: [],
  });
  assert.deepEqual(projectNodePatchBody({ nodeIds: ['visible','visible'] }), {
    nodeIds: ['visible'],
  });
  assert.deepEqual(projectNodePatchBody({ nodeIds: ['not-returned'] }), {
    nodeIds: ['not-returned'],
  });
});
