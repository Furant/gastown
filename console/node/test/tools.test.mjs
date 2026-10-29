import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation, codexCapabilities, cursorCapabilities, parsePlan } from '../tools.mjs';

test('Codex launch is shell-free and applies only supported model reasoning', () => {
  const result = buildInvocation({ kind: 'execute', tool: 'codex', model: 'gpt-6.1-sol', mode: 'high', prompt: 'literal ; do not shell' }, { codex: { command: '/usr/bin/codex' } });
  assert.equal(result.command, '/usr/bin/codex');
  assert.deepEqual(result.args.slice(0, 7), ['exec', '--json', '--sandbox', 'workspace-write', '--model', 'gpt-6.1-sol', '-c']);
  assert.equal(result.args.at(-1), 'literal ; do not shell');
  assert.equal(result.args.at(-2), 'model_reasoning_effort="high"');
  assert.equal(result.shell, false);
});

test('Cursor reasoning variants map to their own native model id', () => {
  const result = buildInvocation({ kind: 'execute', tool: 'cursor', model: 'gpt-5.3-codex', mode: 'high', nativeModel: 'gpt-5.3-codex-high', prompt: 'task' }, { cursor: { command: '/usr/bin/agent' }, capabilities: { tools: { cursor: { models: [{ id: 'gpt-5.3-codex', modes: ['high'], nativeByMode: { high: 'gpt-5.3-codex-high' } }] } } } });
  assert.equal(result.args[0], '--print');
  assert.ok(result.args.includes('--sandbox') && result.args.includes('enabled'));
  assert.ok(result.args.includes('--trust'));
  assert.ok(result.args.includes('--model') && result.args.includes('gpt-5.3-codex-high'));
  assert.equal(result.args.at(-1), 'task');
  assert.equal(result.shell, false);
});

test('planning uses read-only modes and blocks unknown or incompatible settings', () => {
  const codex = buildInvocation({ kind: 'plan', tool: 'codex', model: 'gpt-6.1-sol', mode: 'high', prompt: 'plan' }, { codex: { command: 'codex' } });
  assert.ok(codex.args.includes('read-only'));
  const cursor = buildInvocation({ kind: 'plan', tool: 'cursor', model: 'gpt-5.3-codex', mode: 'high', nativeModel: 'gpt-5.3-codex-high', prompt: 'plan' }, { cursor: { command: 'agent' }, capabilities: { tools: { cursor: { models: [{ id: 'gpt-5.3-codex', modes: ['high'], nativeByMode: { high: 'gpt-5.3-codex-high' } }] } } } });
  assert.ok(cursor.args.includes('ask'));
  assert.throws(() => buildInvocation({ kind: 'execute', tool: 'codex', model: 'mystery', mode: 'high', prompt: 'x' }, { codex: { command: 'codex' }, capabilities: { tools: { codex: { models: [{ id: 'gpt-6.1-sol', modes: ['low', 'high'] }] } } } }), /unsupported/i);
  assert.throws(() => buildInvocation({ kind: 'execute', tool: 'cursor', model: 'gpt-5.3-codex', mode: 'banana', nativeModel: 'x', prompt: 'x' }, { cursor: { command: 'agent' }, capabilities: { tools: { cursor: { models: [{ id: 'gpt-5.3-codex', modes: ['high'], nativeByMode: { high: 'gpt-5.3-codex-high' } }] } } } }), /unsupported/i);
});

test('capabilities are derived from tool catalogs and Cursor modes preserve native variants', () => {
  const c = codexCapabilities([{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }]);
  assert.deepEqual(c[0].modes, ['low', 'high']);
  const cursor = cursorCapabilities(['gpt-5.3-codex-low - Codex 5.3 Low', 'gpt-5.3-codex-high-fast - Codex 5.3 High Fast', 'auto - Auto']);
  const model = cursor.find(m => m.id === 'gpt-5.3-codex');
  assert.deepEqual(model.modes, ['low', 'high']);
  assert.equal(model.nativeByMode.high, 'gpt-5.3-codex-high-fast');
  assert.equal(cursor.find(m => m.id === 'auto').modes[0], 'auto');
});

test('plan output is strictly bounded and rejects malformed agent output', () => {
  assert.deepEqual(parsePlan('{"summary":"Plan","steps":[{"title":"Test","acceptance":"Pass"}]}'), { summary: 'Plan', steps: [{ title: 'Test', acceptance: 'Pass' }] });
  assert.throws(() => parsePlan('not json'), /valid JSON/i);
  assert.throws(() => parsePlan(JSON.stringify({ steps: Array.from({ length: 13 }, () => ({ title: 'x', acceptance: 'y' })) })), /steps/i);
});
