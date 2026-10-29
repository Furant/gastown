import { randomUUID } from 'node:crypto';
import { denied, fail, invalid, missing } from './errors.mjs';
import { hashToken, randomToken } from './auth.mjs';

const deviceKey = value => typeof value === 'string' && /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43,128})$/.test(value);
export function localDeviceHash(value) { return deviceKey(value) ? hashToken(value) : null; }

export async function createPairing(db, user, nodeId, rawDevice) {
  const fingerprint = localDeviceHash(rawDevice);
  if (!fingerprint) invalid('A local browser device key is required');
  const id = randomUUID(), code = randomToken(24), expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await db.transaction(async tx => {
    await tx.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [user.org_id]);
    const node = (await tx.query('SELECT * FROM nodes WHERE id=$1 AND org_id=$2 FOR UPDATE', [nodeId, user.org_id])).rows[0];
    if (!node) missing();
    if (node.owner_id !== user.id || node.revoked_at) denied();
    const projects = (await tx.query('SELECT n.local_device_hash FROM projects p JOIN nodes n ON n.id=p.local_node_id WHERE p.local_node_id=$1 AND p.repo_type=$2 LIMIT 1', [nodeId, 'local'])).rows[0];
    if (projects && projects.local_device_hash !== fingerprint) fail(409, 'local_node_bound', 'This node already has local projects bound to another device');
    if (node.local_device_hash && node.local_device_hash !== fingerprint) fail(409, 'local_node_bound', 'Revoke this node and create another to pair a different computer');
    await tx.query('UPDATE local_pairings SET consumed_at=COALESCE(consumed_at,now()) WHERE node_id=$1 AND consumed_at IS NULL', [nodeId]);
    await tx.query('INSERT INTO local_pairings(id,org_id,node_id,owner_id,device_hash,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,user.org_id,nodeId,user.id,fingerprint,hashToken(code),expiresAt]);
  });
  return { code, expiresAt };
}

export async function confirmPairing(db, node, code) {
  if (typeof code !== 'string' || code.length < 20 || code.length > 128) invalid('A valid pairing code is required');
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [node.org_id]);
    const current = (await tx.query('SELECT * FROM nodes WHERE id=$1 AND org_id=$2 FOR UPDATE', [node.id,node.org_id])).rows[0];
    if (!current || current.revoked_at) fail(401, 'invalid_node_token', 'Valid node authorization required');
    const pairing = (await tx.query('SELECT * FROM local_pairings WHERE code_hash=$1 AND node_id=$2 AND org_id=$3 AND owner_id=$4 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [hashToken(code),current.id,current.org_id,current.owner_id])).rows[0];
    if (!pairing) missing();
    if (current.local_device_hash && current.local_device_hash !== pairing.device_hash) fail(409,'local_node_bound','This node is already paired to another computer');
    await tx.query('UPDATE local_pairings SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL',[pairing.id]);
    await tx.query('UPDATE nodes SET local_device_hash=$2 WHERE id=$1',[current.id,pairing.device_hash]);
    return { paired:true, nodeId:current.id };
  });
}

export async function requireLocalProjectDevice(db, user, project) {
  if (project.repo_type !== 'local') return;
  if (project.visibility !== 'private' || project.owner_id !== user.id || !project.local_node_id || !user.local_device_hash) denied();
  const node = (await db.query('SELECT id,owner_id,local_device_hash FROM nodes WHERE id=$1 AND org_id=$2', [project.local_node_id,user.org_id])).rows[0];
  if (!node || node.owner_id !== user.id || node.local_device_hash !== user.local_device_hash) denied();
}

export async function requireLocalExecutionNode(db, user, project, node) {
  await requireLocalProjectDevice(db,user,project);
  if (project.repo_type === 'local' && (!node || node.id !== project.local_node_id || node.owner_id !== user.id || node.local_device_hash !== user.local_device_hash)) denied();
}

export function validateLocalReview(value) {
  const worktreePath = value?.worktreePath;
  const absoluteWorktree = typeof worktreePath === 'string' && (worktreePath.startsWith('/') && !worktreePath.startsWith('//') || /^[A-Za-z]:[\\/]/.test(worktreePath));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !absoluteWorktree || worktreePath.length > 2048 || /[\0\r\n]/.test(worktreePath) || !Array.isArray(value.files) || value.files.length > 32 || typeof value.diff !== 'string' || value.diff.length > 12000 || Buffer.byteLength(value.diff) > 24000 || typeof value.diffTruncated !== 'boolean' || typeof value.filesTruncated !== 'boolean') invalid('Local review evidence exceeds its limits');
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.length > 240 || /[\0\r\n]/.test(file.path) || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..') || !['added','modified','deleted','renamed','untracked'].includes(file.status)) invalid('Local review contains an invalid changed file');
  }
  if (/[\0]/.test(value.diff) || /(^|\n)\+\+\+ [A-Za-z]:[\\/]/.test(value.diff)) invalid('Local review diff contains an invalid path');
  return {worktreePath:value.worktreePath,files:value.files.map(file=>({path:file.path,status:file.status})),diff:value.diff,diffTruncated:value.diffTruncated,filesTruncated:value.filesTruncated};
}
