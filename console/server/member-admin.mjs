import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.mjs';
import { denied, fail, invalid, missing } from './errors.mjs';

const one = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export async function updateMember(db, actor, id, body) {
  if (actor.role !== 'admin') denied();
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'role', 'disabled'].includes(key)) || !Object.keys(body).length) invalid('Provide a member name, role or disabled state');
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [actor.org_id]);
    const member = (await tx.query('SELECT * FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id])).rows[0];
    if (!member) missing();
    if (body.name !== undefined && !one(body.name, 120)) invalid('Member name must be 1–120 characters');
    if (body.role !== undefined && !['admin', 'member'].includes(body.role)) invalid('Role must be admin or member');
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') invalid('Disabled must be a boolean');
    const disabling = body.disabled === true && !member.disabled_at;
    const enabling = body.disabled === false && !!member.disabled_at;
    const nextRole = body.role ?? member.role;
    if (disabling && member.id === actor.id) fail(409, 'self_disable_forbidden', 'You cannot disable your own account');
    if ((disabling || nextRole !== 'admin' && member.role === 'admin' && !member.disabled_at) && member.role === 'admin') {
      const admins = Number((await tx.query("SELECT count(*)::int AS n FROM users WHERE org_id=$1 AND role='admin' AND disabled_at IS NULL", [actor.org_id])).rows[0].n);
      if (admins <= 1) fail(409, 'last_admin', 'The organization must keep at least one enabled administrator');
    }
    const name = body.name === undefined ? member.name : body.name.trim();
    await tx.query('UPDATE users SET name=$2,role=$3,disabled_at=CASE WHEN $4 THEN now() WHEN $5 THEN NULL ELSE disabled_at END WHERE id=$1', [id, name, nextRole, disabling, enabling]);
    if (disabling) {
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await tx.query('DELETE FROM team_members WHERE user_id=$1', [id]);
      await tx.query('UPDATE nodes SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=$1 AND org_id=$2', [id, actor.org_id]);
      await tx.query("UPDATE connections SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=$1 AND org_id=$2", [id, actor.org_id]);
      for (const table of ['projects', 'nodes', 'connections']) await tx.query(`UPDATE ${table} SET member_ids=(SELECT COALESCE(jsonb_agg(to_jsonb(member.value)),'[]'::jsonb) FROM jsonb_array_elements_text(member_ids) AS member(value) WHERE member.value<>$1) WHERE org_id=$2 AND member_ids ? $1`, [id, actor.org_id]);
      await tx.query("UPDATE tasks SET shared_member_ids=(SELECT COALESCE(jsonb_agg(to_jsonb(member.value)),'[]'::jsonb) FROM jsonb_array_elements_text(shared_member_ids) AS member(value) WHERE member.value<>$1) WHERE org_id=$2 AND shared_member_ids ? $1", [id, actor.org_id]);
      await tx.query("UPDATE tasks t SET status='recovery_required',updated_at=now() WHERE t.org_id=$1 AND t.status IN ('planning','running','stopping') AND t.current_attempt_id IN (SELECT a.id FROM attempts a JOIN nodes n ON n.id=a.node_id WHERE n.owner_id=$2)", [actor.org_id, id]);
      await tx.query("UPDATE attempts a SET status='stop_requested' FROM tasks t,nodes n WHERE t.current_attempt_id=a.id AND a.node_id=n.id AND t.org_id=$1 AND t.owner_id=$2 AND n.owner_id<>$2 AND a.status='running'", [actor.org_id, id]);
      await tx.query("UPDATE tasks t SET status='stopping',stop_intent='cancel',updated_at=now() FROM attempts a,nodes n WHERE t.current_attempt_id=a.id AND a.node_id=n.id AND t.org_id=$1 AND t.owner_id=$2 AND n.owner_id<>$2 AND a.status='stop_requested' AND t.status IN ('planning','running')", [actor.org_id, id]);
    }
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), actor.org_id, actor.id, disabling ? 'member.disabled' : enabling ? 'member.enabled' : 'member.updated', 'member', id, JSON.stringify({nameChanged: body.name !== undefined, role: nextRole})]);
    return (await tx.query('SELECT id,name,email,role,disabled_at,created_at FROM users WHERE id=$1', [id])).rows[0];
  });
}

export async function resetMemberPassword(db, actor, id, password) {
  if (actor.role !== 'admin') denied();
  const encoded = await hashPassword(password);
  return db.transaction(async tx => {
    const member = (await tx.query('SELECT id FROM users WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id])).rows[0];
    if (!member) missing();
    await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, encoded]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), actor.org_id, actor.id, 'member.password_reset', 'member', id, '{}']);
  });
}

export async function changePassword(db, user, body, currentSessionId) {
  if (!one(body?.currentPassword, 256) || !one(body?.newPassword, 256)) invalid('Current and new passwords are required');
  const encoded = await hashPassword(body.newPassword);
  await db.transaction(async tx => {
    const record = (await tx.query('SELECT password_hash FROM users WHERE id=$1 AND org_id=$2 AND disabled_at IS NULL FOR UPDATE', [user.id, user.org_id])).rows[0];
    if (!record || !(await verifyPassword(body.currentPassword, record.password_hash))) fail(403, 'current_password_incorrect', 'Current password is incorrect');
    await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3', [user.id, encoded, record.password_hash]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [user.id, currentSessionId]);
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), user.org_id, user.id, 'member.password_changed', 'member', user.id, '{}']);
  });
}

export async function updateTeam(db, actor, id, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'memberIds'].includes(key)) || !Object.keys(body).length) invalid('Provide a team name or member list');
  if (body.name !== undefined && !one(body.name, 120)) invalid('Team name must be 1–120 characters');
  if (body.memberIds !== undefined) {
    if (!Array.isArray(body.memberIds) || body.memberIds.length > 500 || body.memberIds.some(x => typeof x !== 'string')) invalid('Team member list is invalid');
  }
  let savedTeam;
  try {
    savedTeam = await db.transaction(async tx => {
      await tx.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE', [actor.org_id]);
      const team = (await tx.query('SELECT * FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, actor.org_id])).rows[0];
      if (!team) missing();
      if (team.owner_id !== actor.id && actor.role !== 'admin') denied();
      const existingMembers = (await tx.query('SELECT user_id FROM team_members WHERE team_id=$1', [id])).rows.map(row => row.user_id);
      const memberIds = body.memberIds === undefined ? null : [...new Set([...body.memberIds, team.owner_id])];
      if (memberIds) {
        const valid = await tx.query('SELECT id FROM users WHERE org_id=$1 AND disabled_at IS NULL AND id=ANY($2::text[])', [actor.org_id, memberIds]);
        if (valid.rows.length !== memberIds.length) invalid('Team members must be enabled users in your organization');
      }
      if (body.name !== undefined) await tx.query('UPDATE teams SET name=$2 WHERE id=$1', [id, body.name.trim()]);
      if (memberIds) {
        const removed = existingMembers.filter(userId => !memberIds.includes(userId));
        for (const removedId of removed) {
          await tx.query("UPDATE attempts a SET status='stop_requested' FROM tasks t,connections c WHERE t.current_attempt_id=a.id AND t.connection_id=c.id AND a.status='running' AND t.status IN ('planning','running') AND c.team_id=$1 AND t.owner_id=$2", [id, removedId]);
          await tx.query("UPDATE tasks t SET status='stopping',stop_intent='cancel',updated_at=now() FROM attempts a,connections c WHERE t.current_attempt_id=a.id AND t.connection_id=c.id AND a.status='stop_requested' AND t.status IN ('planning','running') AND c.team_id=$1 AND t.owner_id=$2", [id, removedId]);
          await tx.query("UPDATE attempts a SET status='stop_requested' FROM tasks t,projects p WHERE t.current_attempt_id=a.id AND t.project_id=p.id AND a.status='running' AND t.status IN ('planning','running') AND p.team_id=$1 AND t.owner_id=$2", [id, removedId]);
          await tx.query("UPDATE tasks t SET status='stopping',stop_intent='cancel',updated_at=now() FROM attempts a,projects p WHERE t.current_attempt_id=a.id AND t.project_id=p.id AND a.status='stop_requested' AND t.status IN ('planning','running') AND p.team_id=$1 AND t.owner_id=$2", [id, removedId]);
          await tx.query("UPDATE attempts a SET status='stop_requested' FROM tasks t,connections c,nodes n WHERE t.current_attempt_id=a.id AND t.connection_id=c.id AND a.node_id=n.id AND a.status='running' AND t.status IN ('planning','running') AND n.visibility='team' AND n.team_id=$1 AND t.owner_id=$2", [id, removedId]);
          await tx.query("UPDATE tasks t SET status='stopping',stop_intent='cancel',updated_at=now() FROM attempts a,connections c,nodes n WHERE t.current_attempt_id=a.id AND t.connection_id=c.id AND a.node_id=n.id AND a.status='stop_requested' AND t.status IN ('planning','running') AND n.visibility='team' AND n.team_id=$1 AND t.owner_id=$2", [id, removedId]);
        }
        await tx.query('DELETE FROM team_members WHERE team_id=$1', [id]);
        for (const memberId of memberIds) await tx.query('INSERT INTO team_members(team_id,user_id) VALUES($1,$2)', [id, memberId]);
      }
      await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), actor.org_id, actor.id, 'team.updated', 'team', id, JSON.stringify({nameChanged: body.name !== undefined, membershipChanged: !!memberIds})]);
      const updated = (await tx.query('SELECT * FROM teams WHERE id=$1', [id])).rows[0];
      return { ...updated, member_ids: (await tx.query('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY user_id', [id])).rows.map(row => row.user_id) };
    });
  } catch (error) { if (error.code === '23505') fail(409, 'team_exists', 'A team with that name already exists'); throw error; }
  return savedTeam;
}
