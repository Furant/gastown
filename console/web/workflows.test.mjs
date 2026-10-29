import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointTargetReady, formatRecordedCost, taskLifecycleActions, taskLifecycleActionsFor, validateBudget, validateChildren } from './workflows.mjs';

test('lifecycle controls follow task state and hide actions while stopping', () => {
  assert.deepEqual(taskLifecycleActions('running'), ['pause', 'cancel']);
  assert.deepEqual(taskLifecycleActions('paused'), ['resume', 'cancel']);
  assert.deepEqual(taskLifecycleActions('orchestrating'), ['pause', 'cancel']);
  assert.deepEqual(taskLifecycleActions('stopping'), []);
  assert.deepEqual(taskLifecycleActions('completed'), []);
});

test('child decomposition validates fields, dependency references, and cycles', () => {
  const valid = [
    { key: 'api', title: 'API', description: 'Implement endpoint', connectionId: 'c1', dependsOn: [] },
    { key: 'ui', title: 'UI', description: 'Implement UI', connectionId: 'c2', dependsOn: ['api'] },
  ];
  assert.equal(validateChildren(valid), '');
  assert.match(validateChildren([...valid, { ...valid[0], title: 'Duplicate' }]), /不能重复/);
  assert.match(validateChildren(valid.map(child => child.key === 'api' ? { ...child, dependsOn: ['ui'] } : child)), /循环/);
  assert.match(validateChildren(valid.map(child => child.key === 'api' ? { ...child, connectionId: '' } : child)), /执行连接/);
  assert.match(validateChildren(valid.map(child => child.key === 'api' ? { ...child, key: '_api' } : child)), /以字母或数字开头/);
  assert.equal(validateChildren(valid.map(child => child.key === 'api' ? { ...child, key: ' api ' } : child).map(child => child.key === 'ui' ? { ...child, dependsOn: [' api '] } : child)), '');
});

test('cross-node transfer requires an online node with a fresh reported checkpoint key', () => {
  const now = Date.now();
  assert.equal(checkpointTargetReady({ status: 'offline', checkpointPublicKeyPresent: true, onlineAt: new Date(now).toISOString() }, now).ready, false);
  assert.match(checkpointTargetReady({ status: 'online', checkpointPublicKeyPresent: false, onlineAt: new Date(now).toISOString() }, now).reason, /公钥/);
  assert.match(checkpointTargetReady({ status: 'online', checkpointPublicKeyPresent: true, onlineAt: new Date(now - 61_000).toISOString() }, now).reason, /过期/);
  assert.match(checkpointTargetReady({ status: 'online', checkpointPublicKeyPresent: true, onlineAt: new Date(now - 46_000).toISOString() }, now).reason, /过期/);
  assert.equal(checkpointTargetReady({ status: 'online', checkpointPublicKeyPresent: true, onlineAt: new Date(now - 45_000).toISOString() }, now).ready, true);
  assert.equal(checkpointTargetReady({ status: 'online', checkpointPublicKeyPresent: true, onlineAt: new Date(now).toISOString() }, now).ready, true);
});

test('recovery_required never offers lifecycle retry or resume', () => {
  assert.deepEqual(taskLifecycleActionsFor({ status: 'recovery_required' }), []);
  assert.equal(taskLifecycleActionsFor({ status: 'failed' }).includes('retry'), true);
});

test('usage leaves missing recorded cost unknown', () => {
  assert.equal(formatRecordedCost(null), '未报告');
  assert.equal(formatRecordedCost(undefined), '未报告');
  assert.equal(formatRecordedCost(1_250_000), '1.25 USD');
});

test('budget limits are optional positive integers and enabled budgets need a limit', () => {
  assert.equal(validateBudget({ enabled: true, maxRunsPerDay: '5' }), '');
  assert.equal(validateBudget({ enabled: false, maxRunsPerDay: '' }), '');
  assert.match(validateBudget({ enabled: true, maxRunsPerDay: '' }), /至少填写一项/);
  assert.match(validateBudget({ enabled: true, maxInputTokens: '0' }), /大于 0 的整数/);
  assert.match(validateBudget({ enabled: true, maxOutputTokens: '1.5' }), /大于 0 的整数/);
});
