import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const CONTEXT_FIELDS = ['taskId', 'projectId', 'sourceAttemptId', 'targetNodeId', 'transferId'];
const ENVELOPE_FIELDS = ['version', 'ephemeralPublicKey', 'salt', 'iv', 'tag', 'ciphertext', 'context'];
const DOMAIN = Buffer.from('gastown-team-console/checkpoint/v1');

function canonicalContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).length !== CONTEXT_FIELDS.length) throw new Error('Invalid checkpoint context');
  const result = {};
  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid checkpoint context');
    result[field] = value;
  }
  return result;
}

function publicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 1024 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Invalid checkpoint public key');
  let key;
  try { key = createPublicKey(pem); } catch { throw new Error('Invalid checkpoint public key'); }
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Invalid checkpoint public key');
  return key;
}

function decode(value, { length, maxLength } = {}) {
  if (typeof value !== 'string' || value.length > Math.ceil((maxLength || length) / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid checkpoint envelope encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length && bytes.length !== length) || (maxLength && (!bytes.length || bytes.length > maxLength))) throw new Error('Invalid checkpoint envelope size');
  return bytes;
}

function normalizedEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== ENVELOPE_FIELDS.length) throw new Error('Invalid checkpoint envelope');
  if (envelope.version !== 1) throw new Error('Unsupported checkpoint version');
  publicKey(envelope.ephemeralPublicKey);
  decode(envelope.salt, { length: 32 });
  decode(envelope.iv, { length: 12 });
  decode(envelope.tag, { length: 16 });
  decode(envelope.ciphertext, { maxLength: MAX_CHECKPOINT_BYTES });
  return {
    version: 1, ephemeralPublicKey: envelope.ephemeralPublicKey,
    salt: envelope.salt, iv: envelope.iv, tag: envelope.tag,
    ciphertext: envelope.ciphertext, context: canonicalContext(envelope.context),
  };
}

function deriveKey(privateValue, publicValue, salt) {
  const secret = diffieHellman({ privateKey: privateValue, publicKey: publicValue });
  return Buffer.from(hkdfSync('sha256', secret, salt, DOMAIN, 32));
}

export function generateCheckpointKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function sealCheckpoint(bytes, recipientPublicKey, context) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Invalid checkpoint size');
  const target = publicKey(recipientPublicKey);
  const normalizedContext = canonicalContext(context);
  const ephemeral = generateKeyPairSync('x25519');
  const salt = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(ephemeral.privateKey, target, salt), iv);
  cipher.setAAD(Buffer.from(JSON.stringify({ version: 1, context: normalizedContext })));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    version: 1, ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'), context: normalizedContext,
  };
}

export function openCheckpoint(envelope, recipientPrivateKey, expectedContext) {
  const value = normalizedEnvelope(envelope);
  const context = canonicalContext(expectedContext);
  if (JSON.stringify(value.context) !== JSON.stringify(context)) throw new Error('Checkpoint context does not match the current transfer');
  try {
    if (typeof recipientPrivateKey !== 'string' || recipientPrivateKey.length > 2048) throw new Error('Invalid private key');
    const privateValue = createPrivateKey(recipientPrivateKey);
    if (privateValue.asymmetricKeyType !== 'x25519') throw new Error('Invalid private key');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(privateValue, publicKey(value.ephemeralPublicKey), Buffer.from(value.salt, 'base64')), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify({ version: 1, context })));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
  } catch { throw new Error('Unable to authenticate checkpoint for this recipient'); }
}

export function checkpointDigest(envelope) {
  return createHash('sha256').update(JSON.stringify(normalizedEnvelope(envelope))).digest('hex');
}
