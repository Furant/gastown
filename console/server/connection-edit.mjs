import { randomUUID } from 'node:crypto';
import { asArray, inScope } from './access.mjs';
import { denied, fail, invalid, missing } from './errors.mjs';
import { requireLocalExecutionNode } from './local-projects.mjs';

const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;

export async function editConnection(db, user, id, body, modelMapping) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Connection changes must be an object');
  if (body.projectIds !== undefined && (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 100 || body.projectIds.some(id => !text(id, 80)) || new Set(body.projectIds).size !== body.projectIds.length)) invalid('Connection projects must be a unique list of 1 to 100 project IDs');
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [user.org_id]);
    const actor = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND disabled_at IS NULL', [user.id, user.org_id])).rows[0];
    if (!actor) denied();
    const initial = (await tx.query('SELECT node_id FROM connections WHERE id=$1 AND org_id=$2', [id, actor.org_id])).rows[0];
    if (!initial) missing();
    const node = (await tx.query('SELECT * FROM nodes WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL FOR UPDATE', [initial.node_id, actor.org_id])).rows[0];
    if (!node) fail(409, 'connection_node_unavailable', 'The connection node is unavailable');
    const current = (await tx.query('SELECT * FROM connections WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id])).rows[0];
    if (current.owner_id !== actor.id && actor.role !== 'admin') denied();
    if (current.revoked_at) fail(409, 'connection_revoked', 'Revoked connections cannot be edited');
    const next = {
      model: body.model ?? current.model, mode: body.mode ?? current.mode,
      allowedModels: body.allowedModels ?? asArray(current.allowed_models),
      allowOverride: body.allowOverride ?? current.allow_override,
      maxConcurrency: body.maxConcurrency ?? current.max_concurrency,
      allowAutoFailover: body.allowAutoFailover ?? current.allow_auto_failover,
      projectIds: body.projectIds ?? asArray(current.project_ids),
    };
    if (!Array.isArray(next.allowedModels) || !next.allowedModels.length || next.allowedModels.length > 100 || next.allowedModels.some(model => !text(model, 160)) || typeof next.allowOverride !== 'boolean' || typeof next.allowAutoFailover !== 'boolean' || !Number.isInteger(next.maxConcurrency) || next.maxConcurrency < 1 || next.maxConcurrency > 32) invalid('Invalid model, reasoning mode, access or concurrency');
    const removed = asArray(current.project_ids).filter(id => !next.projectIds.includes(id));
    if (removed.length) {
      const pending = Number((await tx.query("SELECT count(*)::int AS n FROM tasks WHERE connection_id=$1 AND project_id=ANY($2::text[]) AND status NOT IN ('completed','failed','canceled')", [id, removed])).rows[0].n);
      if (pending) fail(409, 'connection_projects_in_use', 'Cancel or complete tasks using removed projects before changing the connection grants');
    }
    const teams = new Set((await tx.query('SELECT team_id FROM team_members WHERE user_id=$1', [actor.id])).rows.map(row => row.team_id));
    const owner = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 AND disabled_at IS NULL', [current.owner_id, actor.org_id])).rows[0];
    if (!owner) denied();
    const ownerTeams = new Set((await tx.query('SELECT team_id FROM team_members WHERE user_id=$1', [owner.id])).rows.map(row => row.team_id));
    for (const projectId of next.projectIds) {
      const project = (await tx.query('SELECT * FROM projects WHERE id=$1 AND org_id=$2', [projectId, actor.org_id])).rows[0];
      if (!project || !inScope(project, actor, teams) || !inScope(project, owner, ownerTeams)) denied();
      if (!asArray(node.project_ids).includes(projectId)) fail(400, 'node_project_grant_required', 'The execution node must be granted each connection project');
      await requireLocalExecutionNode(tx, { ...actor, local_device_hash: user.local_device_hash }, project, node);
      if (project.repo_type === 'local' && (next.allowAutoFailover || current.visibility !== 'private')) invalid('Local project connections must stay private and cannot enable automatic failover');
    }
    const capabilities = typeof node.capabilities === 'string' ? JSON.parse(node.capabilities) : node.capabilities;
    for (const model of next.allowedModels) if (!capabilities.tools.find(tool => tool.tool === current.tool)?.models.some(value => value.id === model)) invalid('The node has not reported this model');
    modelMapping(capabilities, current.tool, next.model, next.mode);
    if (!next.allowedModels.includes(next.model)) invalid('The default model must be authorized');
    const updated = (await tx.query('UPDATE connections SET model=$2,mode=$3,allowed_models=$4::jsonb,allow_override=$5,max_concurrency=$6,allow_auto_failover=$7,project_ids=$8::jsonb WHERE id=$1 RETURNING *', [id, next.model, next.mode, JSON.stringify(next.allowedModels), next.allowOverride, next.maxConcurrency, next.allowAutoFailover, JSON.stringify(next.projectIds)])).rows[0];
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), actor.org_id, actor.id, 'connection.updated', 'connection', id, JSON.stringify({ model: next.model, mode: next.mode, projectIdsAdded: next.projectIds.filter(id => !asArray(current.project_ids).includes(id)), projectIdsRemoved: removed })]);
    return updated;
  });
}
