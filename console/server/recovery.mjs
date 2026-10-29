import { randomUUID } from 'node:crypto';
import { hashToken } from './auth.mjs';
import { fail, invalid } from './errors.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;

export async function recoverAttempt(db, node, body) {
  if (!body || typeof body.attemptId !== 'string' || !body.attemptId || body.attemptId.length > 80 || typeof body.leaseToken !== 'string' || body.leaseToken.length > 200 || !['stopped', 'unknown'].includes(body.outcome)) invalid('Attempt, lease and recovery outcome are required');
  if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) invalid('Recovery message is too long');
  if (body.outcome === 'stopped' && body.checkpoint !== undefined && (!body.checkpoint || typeof body.checkpoint.branch !== 'string' || body.checkpoint.branch.length > 240 || typeof body.checkpoint.dirty !== 'boolean')) invalid('Checkpoint metadata is invalid');
  return db.transaction(async tx => {
    const attempt = (await tx.query('SELECT * FROM attempts WHERE id=$1 AND node_id=$2 FOR UPDATE', [body.attemptId, node.id])).rows[0];
    if (!attempt || attempt.lease_hash !== hashToken(body.leaseToken) || !['running', 'stop_requested'].includes(attempt.status)) fail(409, 'stale_attempt', 'This worker attempt is no longer active');
    const task = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [attempt.task_id])).rows[0];
    if (!task || task.current_attempt_id !== attempt.id) fail(409, 'stale_attempt', 'This worker attempt is no longer active');
    const connection = (await tx.query('SELECT id FROM connections WHERE id=$1 AND org_id=$2 AND node_id=$3', [attempt.connection_id, task.org_id, node.id])).rows[0];
    if (!connection) fail(409, 'stale_attempt', 'Execution permissions have changed');
    if (task.stop_intent || task.status === 'stopping' || attempt.status === 'stop_requested') fail(409, 'stop_intent_pending', 'Use the existing stop or transfer protocol to finish this attempt');
    let status;
    if (body.outcome === 'stopped') {
      status = 'paused';
      await tx.query("UPDATE attempts SET status='stopped',ended_at=now() WHERE id=$1", [attempt.id]);
      await tx.query("UPDATE tasks SET status='paused',current_attempt_id=NULL,updated_at=now() WHERE id=$1", [task.id]);
    } else {
      status = 'recovery_required';
      await tx.query("UPDATE tasks SET status='recovery_required',updated_at=now() WHERE id=$1", [task.id]);
    }
    await tx.query('INSERT INTO task_events(id,org_id,task_id,attempt_id,type,message,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), task.org_id, task.id, attempt.id, 'recovery', text(body.message) ? body.message.trim() : `Worker recovery outcome: ${body.outcome}`, JSON.stringify({outcome: body.outcome, checkpoint: body.checkpoint || null})]);
    return { accepted: true, status };
  });
}
