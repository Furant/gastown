import { randomUUID } from 'node:crypto';
import { fail, invalid } from './errors.mjs';
import { hashToken } from './auth.mjs';
import { asArray, inScope } from './access.mjs';

const one = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

async function authorized(tx, userId, orgId, projectId, connectionId, nodeId, model, mode) {
  const connection = (await tx.query('SELECT * FROM connections WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [connectionId, orgId])).rows[0];
  const node = (await tx.query('SELECT * FROM nodes WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [nodeId, orgId])).rows[0];
  const project = (await tx.query('SELECT * FROM projects WHERE id=$1 AND org_id=$2', [projectId, orgId])).rows[0];
  const owner = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [userId, orgId])).rows[0];
  if (!connection || !node || !project || !owner || connection.node_id !== node.id || !asArray(connection.project_ids).includes(projectId) || !asArray(project.node_ids).includes(node.id) || !asArray(connection.allowed_models).includes(model) || ((connection.model !== model || connection.mode !== mode) && !connection.allow_override)) return false;
  const ownerTeams = new Set((await tx.query('SELECT team_id FROM team_members WHERE user_id=$1', [owner.id])).rows.map(row => row.team_id));
  return inScope(connection, owner, ownerTeams) && inScope(node, owner, ownerTeams) && inScope(project, owner, ownerTeams);
}

function exactContext(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).length !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function cryptoApi() {
  return import('../shared/checkpoint-crypto.mjs');
}

export async function saveCheckpoint(db, node, body) {
  if (!one(body.attemptId, 80) || !one(body.leaseToken, 200) || !one(body.transferId, 100) || !body.envelope || typeof body.envelope !== 'object' || Array.isArray(body.envelope)) invalid('Attempt, lease, transfer and checkpoint envelope are required');
  const size = Buffer.byteLength(JSON.stringify(body.envelope));
  if (size > 15 * 1024 * 1024) fail(413, 'checkpoint_too_large', 'Checkpoint envelope exceeds the 15 MiB payload limit');
  const { checkpointDigest } = await cryptoApi();
  let digest; try { digest = checkpointDigest(body.envelope); } catch { invalid('Invalid checkpoint envelope'); }
  return db.transaction(async tx => {
    const attempt = (await tx.query('SELECT * FROM attempts WHERE id=$1 AND node_id=$2 FOR UPDATE', [body.attemptId, node.id])).rows[0];
    if (!attempt || attempt.status !== 'stop_requested' || attempt.lease_hash !== hashToken(body.leaseToken)) fail(409, 'stale_attempt', 'This worker attempt is no longer active');
    const task = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [attempt.task_id])).rows[0];
    if (!task || task.current_attempt_id !== attempt.id || task.stop_intent !== 'transfer' || task.handoff_transfer_id !== body.transferId || !task.handoff_target_id) fail(409, 'invalid_transfer', 'No matching checkpoint transfer is pending');
    const project=(await tx.query('SELECT repo_type FROM projects WHERE id=$1',[task.project_id])).rows[0];if(project?.repo_type==='local')fail(409,'local_transfer_disabled','Local project checkpoints cannot move between nodes');
    const target = (await tx.query('SELECT n.id,n.checkpoint_public_key,n.online_at,n.revoked_at,c.project_ids,p.node_ids AS project_node_ids FROM connections c JOIN nodes n ON n.id=c.node_id JOIN projects p ON p.id=$3 WHERE c.id=$1 AND c.org_id=$2 AND c.revoked_at IS NULL', [task.handoff_target_id, task.org_id, task.project_id])).rows[0];
    if (!target || target.id === node.id || target.revoked_at || !target.online_at || Date.now() - new Date(target.online_at).getTime() > 45000 || !target.checkpoint_public_key || !target.project_ids.includes(task.project_id) || !target.project_node_ids.includes(target.id)) fail(409, 'target_unavailable', 'Target node is no longer eligible for checkpoint transfer');
    if (!await authorized(tx, task.owner_id, task.org_id, task.project_id, attempt.connection_id, node.id, attempt.model, attempt.mode) || !await authorized(tx, task.owner_id, task.org_id, task.project_id, task.handoff_target_id, target.id, task.handoff_model || task.model, task.handoff_mode || task.mode)) fail(409, 'permissions_changed', 'Execution permissions changed during checkpoint transfer');
    const expected = {taskId: task.id, projectId: task.project_id, sourceAttemptId: attempt.id, targetNodeId: target.id, transferId: task.handoff_transfer_id};
    if (!exactContext(body.envelope.context, expected)) fail(400, 'checkpoint_context_mismatch', 'Checkpoint does not match this transfer');
    const existing = (await tx.query('SELECT id,digest FROM task_checkpoints WHERE transfer_id=$1', [task.handoff_transfer_id])).rows[0];
    if (existing) { if (existing.digest === digest) return {checkpointId: existing.id, digest}; fail(409, 'checkpoint_already_uploaded', 'A different checkpoint was already uploaded for this transfer'); }
    const id = randomUUID();
    await tx.query('INSERT INTO task_checkpoints(id,org_id,task_id,source_attempt_id,target_node_id,transfer_id,digest,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [id, task.org_id, task.id, attempt.id, target.id, body.transferId, digest, JSON.stringify(body.envelope)]);
    return { checkpointId: id, digest };
  });
}

export async function readCheckpoint(db, node, checkpointId, body) {
  if (!one(body.attemptId, 80) || !one(body.leaseToken, 200)) invalid('Attempt and lease are required');
  return db.transaction(async tx => {
    const attempt = (await tx.query('SELECT * FROM attempts WHERE id=$1 AND node_id=$2 FOR UPDATE', [body.attemptId, node.id])).rows[0];
    if (!attempt || attempt.status !== 'running' || attempt.lease_hash !== hashToken(body.leaseToken)) fail(409, 'stale_attempt', 'This worker attempt is no longer active');
    const task = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [attempt.task_id])).rows[0];
    if (!task || task.current_attempt_id !== attempt.id) fail(409, 'stale_attempt', 'This worker attempt is no longer active');
    const project=(await tx.query('SELECT repo_type FROM projects WHERE id=$1',[task.project_id])).rows[0];if(project?.repo_type==='local')fail(409,'local_transfer_disabled','Local project checkpoints cannot move between nodes');
    if (attempt.connection_id !== task.connection_id || !await authorized(tx, task.owner_id, task.org_id, task.project_id, attempt.connection_id, node.id, task.model, task.mode)) fail(409, 'permissions_changed', 'Execution permissions changed during checkpoint recovery');
    const checkpoint = (await tx.query('SELECT * FROM task_checkpoints WHERE id=$1 AND task_id=$2 AND target_node_id=$3', [checkpointId, task.id, node.id])).rows[0];
    if (!checkpoint || !task.handoff_checkpoint || task.handoff_checkpoint.checkpointId !== checkpoint.id || task.handoff_checkpoint.digest !== checkpoint.digest) fail(404, 'checkpoint_not_found', 'Checkpoint is unavailable to this attempt');
    const { checkpointDigest } = await cryptoApi();
    let digest; try { digest = checkpointDigest(checkpoint.envelope); } catch { fail(409, 'checkpoint_corrupt', 'Checkpoint integrity verification failed'); }
    if (digest !== checkpoint.digest) fail(409, 'checkpoint_corrupt', 'Checkpoint integrity verification failed');
    return { checkpointId: checkpoint.id, digest: checkpoint.digest, envelope: checkpoint.envelope };
  });
}
