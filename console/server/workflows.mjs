import { randomUUID } from 'node:crypto';
import { fail, invalid } from './errors.mjs';

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const arr = value => Array.isArray(value) ? value : json(value || '[]');

export async function loadTask(db, id) {
  return (await db.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
}

export async function workflowChildren(db, parentId) {
  const rows = (await db.query('SELECT * FROM tasks WHERE parent_task_id=$1 ORDER BY created_at,id', [parentId])).rows;
  return Promise.all(rows.map(async row => {
    const edges = (await db.query('SELECT dependency_task_id FROM task_dependencies WHERE child_task_id=$1 ORDER BY dependency_task_id', [row.id])).rows;
    const deps = [];
    for (const edge of edges) {
      const dep = (await db.query('SELECT workflow_key FROM tasks WHERE id=$1', [edge.dependency_task_id])).rows[0];
      if (dep?.workflow_key) deps.push(dep.workflow_key);
    }
    return { id: row.id, key: row.workflow_key, title: row.title, status: row.status, connectionId: row.connection_id, dependsOn: deps, result: json(row.result) };
  }));
}

export async function dependencyContext(tx, childId) {
  const rows = (await tx.query('SELECT dependency_task_id FROM task_dependencies WHERE child_task_id=$1 ORDER BY dependency_task_id', [childId])).rows;
  const results = [];
  for (const edge of rows) {
    const row = (await tx.query('SELECT workflow_key,status,result FROM tasks WHERE id=$1', [edge.dependency_task_id])).rows[0];
    if (row) { const result = json(row.result) || {}; results.push({ key: row.workflow_key, status: row.status, ...result, result }); }
  }
  return results;
}

export async function advanceWorkflow(tx, task, resultStatus) {
  if (!task.parent_task_id) return;
  const parent = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [task.parent_task_id])).rows[0];
  if (!parent) return;
  if (parent.stop_intent === 'workflow_pause' || parent.stop_intent === 'workflow_cancel') {
    const active = Number((await tx.query("SELECT count(*)::int AS n FROM tasks WHERE parent_task_id=$1 AND status IN ('stopping','running','planning')", [parent.id])).rows[0].n);
    if (!active) await tx.query('UPDATE tasks SET status=$2,stop_intent=NULL,current_attempt_id=NULL,updated_at=now() WHERE id=$1', [parent.id, parent.stop_intent === 'workflow_pause' ? 'paused' : 'canceled']);
    return;
  }
  if (parent.status !== 'orchestrating') return;
  if (resultStatus === 'awaiting_review' && parent.status === 'orchestrating') {
    await tx.query("UPDATE tasks child SET status='queued',allow_push=$2,allow_pr=$3,updated_at=now() WHERE child.parent_task_id=$1 AND child.status='blocked' AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.dependency_task_id WHERE d.child_task_id=child.id AND dep.status NOT IN ('awaiting_review','completed'))", [parent.id, parent.allow_push, parent.allow_pr]);
  }
  const children = (await tx.query('SELECT status FROM tasks WHERE parent_task_id=$1', [parent.id])).rows;
  if (!children.length) return;
  if (children.some(child => ['failed', 'canceled'].includes(child.status))) {
    await tx.query("UPDATE tasks SET status='failed',current_attempt_id=NULL,updated_at=now() WHERE id=$1", [parent.id]);
  } else if (children.every(child => ['awaiting_review', 'completed'].includes(child.status))) {
    await tx.query("UPDATE tasks SET status='awaiting_review',result=$2::jsonb,updated_at=now() WHERE id=$1", [parent.id, JSON.stringify({ summary: 'All child tasks completed and are awaiting review' })]);
  }
}

export async function decomposeTask(db, user, parent, children, access) {
  if (parent.parent_task_id || parent.status !== 'awaiting_approval' || !parent.plan) fail(409, 'invalid_task_state', 'Only a planned parent task can be decomposed');
  if (!Array.isArray(children) || children.length < 1 || children.length > 12) invalid('Provide 1 to 12 child tasks');
  const byKey = new Map();
  for (const child of children) {
    if (!child || !text(child.key, 64) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(child.key) || byKey.has(child.key) || !text(child.title, 300) || !text(child.description, 16 * 1024) || !text(child.connectionId, 160) || !Array.isArray(child.dependsOn || [])) invalid('Each child needs a unique key, title, requirements, connection and dependency list');
    byKey.set(child.key, child);
  }
  const marks = new Map();
  function visit(key) {
    if (marks.get(key) === 1) invalid('Task dependencies must be acyclic');
    if (marks.get(key) === 2) return;
    const child = byKey.get(key); if (!child) invalid('Dependencies must reference child keys in this decomposition');
    marks.set(key, 1);
    const deps = child.dependsOn || [];
    if (new Set(deps).size !== deps.length || deps.includes(key)) invalid('Dependencies must be unique and cannot include the child itself');
    for (const dep of deps) visit(dep);
    marks.set(key, 2);
  }
  for (const key of byKey.keys()) visit(key);
  const teams = await access.teamsFor(user), ids = new Map();
  for (const child of children) {
    const c = (await db.query('SELECT c.*,p.node_ids AS project_node_ids,n.revoked_at AS node_revoked,n.owner_id AS node_owner_id,n.visibility AS node_visibility,n.team_id AS node_team_id,n.member_ids AS node_member_ids FROM connections c JOIN nodes n ON n.id=c.node_id JOIN projects p ON p.id=$3 WHERE c.id=$1 AND c.org_id=$2 AND c.revoked_at IS NULL', [child.connectionId, user.org_id, parent.project_id])).rows[0];
    if (!c || c.node_revoked || !arr(c.project_ids).includes(parent.project_id) || !arr(c.project_node_ids).includes(c.node_id)) fail(403, 'task_connection_not_allowed', 'A selected connection cannot access this project');
    access.allowed(user, c, teams);
    access.allowed(user, {id:c.node_id,org_id:c.org_id,owner_id:c.node_owner_id,visibility:c.node_visibility,team_id:c.node_team_id,member_ids:c.node_member_ids}, teams);
    const caps = (await db.query('SELECT capabilities FROM nodes WHERE id=$1', [c.node_id])).rows[0]?.capabilities;
    const mapped = access.modelMapping(json(caps), c.tool, c.model, c.mode);
    ids.set(child.key, { id: randomUUID(), connection: c, mapped });
  }
  await db.transaction(async tx => {
    const current = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [parent.id])).rows[0];
    if (current.status !== 'awaiting_approval' || current.parent_task_id) fail(409, 'invalid_task_state', 'Parent task changed while decomposition was being prepared');
    const duplicates = (await tx.query('SELECT 1 FROM tasks WHERE parent_task_id=$1 LIMIT 1', [parent.id])).rows.length;
    if (duplicates) fail(409, 'already_decomposed', 'This task already has child tasks');
    for (const child of children) {
      const { id, connection: c, mapped } = ids.get(child.key);
      await tx.query("INSERT INTO tasks(id,org_id,owner_id,project_id,title,description,status,connection_id,tool,model,mode,native_model,parent_task_id,workflow_key,shared_team_id,shared_member_ids) VALUES($1,$2,$3,$4,$5,$6,'blocked',$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)", [id, user.org_id, user.id, parent.project_id, child.title.trim(), child.description.trim(), c.id, c.tool, mapped.model, mapped.mode, mapped.nativeModel, parent.id, child.key, parent.shared_team_id, JSON.stringify(arr(parent.shared_member_ids))]);
    }
    for (const child of children) for (const key of child.dependsOn || []) await tx.query('INSERT INTO task_dependencies(parent_task_id,child_task_id,dependency_task_id) VALUES($1,$2,$3)', [parent.id, ids.get(child.key).id, ids.get(key).id]);
    await tx.query("INSERT INTO task_events(id,org_id,task_id,type,message,data,actor_id) VALUES($1,$2,$3,'decomposed','Task decomposed into child tasks',$4::jsonb,$5)", [randomUUID(), user.org_id, parent.id, JSON.stringify({ childCount: children.length, keys: children.map(c => c.key) }), user.id]);
  });
  return workflowChildren(db, parent.id);
}

export async function mutateTaskLifecycle(db, user, task, action) {
  const status = task.status;
  return db.transaction(async tx => {
    const t = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [task.id])).rows[0];
    if (t.status !== status) fail(409, 'task_state_changed', 'Task state changed; refresh and retry');
    let next, code = 200, stop = null;
    if (action === 'pause') {
      if (['queued', 'planning_queued', 'blocked'].includes(status)) next = 'paused';
      else if (['running', 'planning'].includes(status)) { next = 'stopping'; stop = 'pause'; code = 202; }
      else if (status === 'orchestrating' && !t.parent_task_id) { next = 'stopping'; stop = 'workflow_pause'; code = 202; }
      else fail(409, 'invalid_task_state', 'Task cannot be paused in its current state');
    } else if (action === 'cancel') {
      if (['queued', 'planning_queued', 'blocked', 'paused', 'awaiting_approval', 'awaiting_review', 'quota_blocked', 'failed'].includes(status)) next = 'canceled';
      else if (['running', 'planning'].includes(status)) { next = 'stopping'; stop = 'cancel'; code = 202; }
      else if (status === 'orchestrating' && !t.parent_task_id) { next = 'stopping'; stop = 'workflow_cancel'; code = 202; }
      else fail(409, 'invalid_task_state', 'Task cannot be canceled in its current state');
    } else if (action === 'resume') {
      if (status !== 'paused') fail(409, 'invalid_task_state', 'Only paused tasks can be resumed');
      if (t.parent_task_id) next = (await tx.query("SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.dependency_task_id WHERE d.child_task_id=$1 AND dep.status NOT IN ('awaiting_review','completed') LIMIT 1", [t.id])).rows.length ? 'blocked' : 'queued';
      else if ((await tx.query('SELECT 1 FROM tasks WHERE parent_task_id=$1 LIMIT 1', [t.id])).rows.length) next = 'orchestrating';
      else next = t.plan ? 'queued' : 'planning_queued';
    } else {
      if (!['failed', 'quota_blocked', 'canceled'].includes(status)) fail(409, 'invalid_task_state', 'Only failed, quota-blocked or canceled tasks can be retried');
      if (t.parent_task_id) next = (await tx.query("SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.dependency_task_id WHERE d.child_task_id=$1 AND dep.status NOT IN ('awaiting_review','completed') LIMIT 1", [t.id])).rows.length ? 'blocked' : 'queued';
      else if ((await tx.query('SELECT 1 FROM tasks WHERE parent_task_id=$1 LIMIT 1', [t.id])).rows.length) next = 'orchestrating';
      else next = t.plan ? 'queued' : 'planning_queued';
      await tx.query('UPDATE tasks SET retry_generation=retry_generation+1 WHERE id=$1', [t.id]);
    }
    if (stop) await tx.query("UPDATE attempts SET status='stop_requested' WHERE id=$1 AND status='running'", [t.current_attempt_id]);
    await tx.query('UPDATE tasks SET status=$2,stop_intent=$3,updated_at=now() WHERE id=$1', [t.id, next, stop]);
    if (stop === 'workflow_pause' || stop === 'workflow_cancel') {
      const childStatus = stop === 'workflow_pause' ? 'paused' : 'canceled';
      await tx.query("UPDATE attempts SET status='stop_requested' WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=$1) AND status='running'", [t.id]);
      await tx.query("UPDATE tasks SET status='stopping',stop_intent=$2,updated_at=now() WHERE parent_task_id=$1 AND status IN ('running','planning')", [t.id, stop === 'workflow_pause' ? 'pause' : 'cancel']);
      await tx.query("UPDATE tasks SET status=$2,stop_intent=NULL,updated_at=now() WHERE parent_task_id=$1 AND status IN ('queued','planning_queued','blocked','paused','awaiting_review','quota_blocked','failed')", [t.id, childStatus]);
      const active = Number((await tx.query("SELECT count(*)::int AS n FROM tasks WHERE parent_task_id=$1 AND status IN ('stopping','running','planning')", [t.id])).rows[0].n);
      if (!active) { next = childStatus; code = 200; await tx.query('UPDATE tasks SET status=$2,stop_intent=NULL,updated_at=now() WHERE id=$1', [t.id, next]); }
    } else if (action === 'resume' && !t.parent_task_id && next === 'orchestrating') {
      await tx.query("UPDATE tasks child SET status=CASE WHEN EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.dependency_task_id WHERE d.child_task_id=child.id AND dep.status NOT IN ('awaiting_review','completed')) THEN 'blocked' ELSE 'queued' END,stop_intent=NULL,updated_at=now() WHERE child.parent_task_id=$1 AND child.status='paused'", [t.id]);
    } else if (action === 'retry' && !t.parent_task_id && next === 'orchestrating') {
      await tx.query("UPDATE tasks child SET status=CASE WHEN EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.dependency_task_id WHERE d.child_task_id=child.id AND dep.status NOT IN ('awaiting_review','completed')) THEN 'blocked' ELSE 'queued' END,stop_intent=NULL,retry_generation=retry_generation+1,updated_at=now() WHERE child.parent_task_id=$1 AND child.status IN ('paused','failed','canceled','quota_blocked')", [t.id]);
    }
    await tx.query('INSERT INTO task_events(id,org_id,task_id,attempt_id,type,message,data,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [randomUUID(), t.org_id, t.id, t.current_attempt_id, `task_${action}_requested`, `Task ${action} requested by ${user.name}`, JSON.stringify({ from: status, to: next }), user.id]);
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), t.org_id, user.id, `task.${action}`, 'task', t.id, JSON.stringify({ status: next })]);
    return code;
  });
}
