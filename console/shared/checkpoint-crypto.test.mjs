import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateCheckpointKeys, sealCheckpoint, openCheckpoint, checkpointDigest, MAX_CHECKPOINT_BYTES } from './checkpoint-crypto.mjs';

const context = () => ({ taskId: 'task-1', projectId: 'project-1', sourceAttemptId: 'attempt-1', targetNodeId: 'node-2', transferId: 'transfer-1' });

test('checkpoint encryption round-trips binary work and stores no node private key', () => {
  const keys = generateCheckpointKeys();
  const bytes = randomBytes(2048);
  const envelope = sealCheckpoint(bytes, keys.publicKey, context());
  assert.deepEqual(openCheckpoint(envelope, keys.privateKey, context()), bytes);
  assert.equal(JSON.stringify(envelope).includes(keys.privateKey), false);
  assert.equal(envelope.version, 1);
  assert.match(checkpointDigest(envelope), /^[a-f0-9]{64}$/);
});

test('wrong recipients, altered context and ciphertext never decrypt', () => {
  const keys = generateCheckpointKeys();
  const wrong = generateCheckpointKeys();
  const envelope = sealCheckpoint(Buffer.from('source working changes'), keys.publicKey, context());
  assert.throws(() => openCheckpoint(envelope, wrong.privateKey, context()), /authenticate/i);
  assert.throws(() => openCheckpoint(envelope, keys.privateKey, { ...context(), targetNodeId: 'node-3' }), /context/i);
  const changed = Buffer.from(envelope.ciphertext, 'base64');
  changed[0] ^= 1;
  const tampered = { ...envelope, ciphertext: changed.toString('base64') };
  assert.throws(() => openCheckpoint(tampered, keys.privateKey, context()), /authenticate/i);
  assert.notEqual(checkpointDigest(tampered), checkpointDigest(envelope));
});

test('checkpoint contexts bind every task, project, attempt, transfer and recipient', () => {
  const keys = generateCheckpointKeys();
  const envelope = sealCheckpoint(Buffer.from('changes'), keys.publicKey, context());
  for (const field of Object.keys(context())) {
    assert.throws(() => openCheckpoint(envelope, keys.privateKey, { ...context(), [field]: 'different' }), /context/i);
  }
  assert.throws(() => sealCheckpoint(Buffer.from('changes'), keys.publicKey, { ...context(), unexpected: 'value' }), /context/i);
});

test('malformed, downgraded and oversized checkpoint envelopes fail before import', () => {
  const keys = generateCheckpointKeys();
  const envelope = sealCheckpoint(Buffer.from('changes'), keys.publicKey, context());
  assert.throws(() => openCheckpoint({ ...envelope, version: 0 }, keys.privateKey, context()), /version/i);
  assert.throws(() => openCheckpoint({ ...envelope, iv: 'not-base64' }, keys.privateKey, context()), /envelope/i);
  assert.throws(() => sealCheckpoint(Buffer.alloc(MAX_CHECKPOINT_BYTES + 1), keys.publicKey, context()), /size/i);
  assert.throws(() => sealCheckpoint(Buffer.from('changes'), keys.privateKey, context()), /public key/i);
});

test('digest is deterministic for envelope property ordering and randomized encryption differs', () => {
  const keys = generateCheckpointKeys();
  const first = sealCheckpoint(Buffer.from('changes'), keys.publicKey, context());
  const second = sealCheckpoint(Buffer.from('changes'), keys.publicKey, context());
  assert.notEqual(checkpointDigest(first), checkpointDigest(second));
  assert.equal(checkpointDigest(first), checkpointDigest(Object.fromEntries(Object.entries(first).reverse())));
});

test('binary checkpoint validation handles realistic payloads without regex stack exhaustion', () => {
  const keys = generateCheckpointKeys();
  const bytes = randomBytes(1024 * 1024);
  const envelope = sealCheckpoint(bytes, keys.publicKey, context());
  assert.deepEqual(openCheckpoint(envelope, keys.privateKey, context()), bytes);
});
