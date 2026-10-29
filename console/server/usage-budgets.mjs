import { randomUUID } from 'node:crypto';
import { denied, invalid } from './errors.mjs';
import { requireProject } from './access.mjs';

const LIMIT_KEYS = ['maxRunsPerDay', 'maxInputTokens', 'maxOutputTokens', 'maxRecordedCostMicros'];
const MAX_COUNT = 9_000_000_000_000;
const validCount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
const utcDay = () => new Date().toISOString().slice(0, 10);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};

function response(projectId, enabled, limits = {}) {
  return { projectId, enabled, ...Object.fromEntries(LIMIT_KEYS.map(key => [key, limits[key] ?? null])), currency: 'USD', timezone: 'UTC', day: utcDay() };
}

export async function getBudget(db, user, projectId) {
  const project = await requireProject(db, user, projectId);
  return response(project.id, project.budget_enabled, parse(project.budget_limits));
}

export async function putBudget(db, user, projectId, body) {
  const project = await requireProject(db, user, projectId);
  if (project.owner_id !== user.id && user.role !== 'admin') denied();
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => !['enabled', 'currency', ...LIMIT_KEYS].includes(key)) || body.currency !== undefined && body.currency !== 'USD') invalid('Budget must use supported USD recorded-cost limits');
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const value = body[key];
    if (value !== undefined && value !== null && !validCount(value)) invalid(`${key} must be a nonnegative safe integer`);
    if (value !== undefined && value !== null) limits[key] = value;
  }
  if (body.enabled && !Object.keys(limits).length) invalid('Set at least one budget limit');
  await db.transaction(async tx => {
    await tx.query('UPDATE projects SET budget_enabled=$2,budget_limits=$3::jsonb WHERE id=$1', [projectId, body.enabled, JSON.stringify(limits)]);
    await tx.query('INSERT INTO audit(id,org_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), user.org_id, user.id, 'project.budget_updated', 'project', projectId, JSON.stringify({enabled: body.enabled, limits})]);
  });
  return response(projectId, body.enabled, limits);
}

export async function getUsage(db, user, projectId) {
  const project = await requireProject(db, user, projectId);
  const since = `date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const totals = (await db.query(`SELECT COALESCE(sum(input_tokens),0)::bigint AS input_tokens,COALESCE(sum(output_tokens),0)::bigint AS output_tokens,COALESCE(sum(cached_input_tokens),0)::bigint AS cached_input_tokens,sum(cost_micros)::bigint AS recorded_cost_micros,count(DISTINCT attempt_id) FILTER (WHERE cost_micros IS NOT NULL)::int AS known_runs FROM usage_events WHERE project_id=$1 AND created_at >= ${since}`, [project.id])).rows[0];
  const attempts = (await db.query(`SELECT count(*)::int AS all_runs,count(*) FILTER (WHERE started_at >= ${since})::int AS day_runs FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.project_id=$1`, [project.id])).rows[0];
  const knownRuns = Number(totals.known_runs || 0), allRuns = Number(attempts.day_runs || 0);
  return { projectId: project.id, currency: 'USD', timezone: 'UTC', day: utcDay(), runCount: allRuns, inputTokens: Number(totals.input_tokens), outputTokens: Number(totals.output_tokens), cachedInputTokens: Number(totals.cached_input_tokens), recordedCostMicros: totals.recorded_cost_micros === null ? null : Number(totals.recorded_cost_micros), costCoverage: { knownRuns, unknownRuns: Math.max(0, allRuns - knownRuns) } };
}

export async function checkBudget(tx, project) {
  if (!project.budget_enabled) return null;
  const limits = parse(project.budget_limits);
  const since = `date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const sums = (await tx.query(`SELECT COALESCE(sum(input_tokens),0)::bigint AS input_tokens,COALESCE(sum(output_tokens),0)::bigint AS output_tokens,sum(cost_micros)::bigint AS cost,count(cost_micros)::int AS known_cost_events FROM usage_events WHERE project_id=$1 AND created_at >= ${since}`, [project.id])).rows[0];
  const runs = Number((await tx.query(`SELECT count(*)::int AS n FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.project_id=$1 AND a.started_at >= ${since}`, [project.id])).rows[0].n);
  if (limits.maxRunsPerDay !== undefined && runs >= limits.maxRunsPerDay) return 'Daily run limit reached';
  if (limits.maxInputTokens !== undefined && Number(sums.input_tokens) >= limits.maxInputTokens) return 'Daily input token limit reached';
  if (limits.maxOutputTokens !== undefined && Number(sums.output_tokens) >= limits.maxOutputTokens) return 'Daily output token limit reached';
  if (limits.maxRecordedCostMicros !== undefined) {
    if (Number(sums.known_cost_events) === 0) return 'Recorded cost is unknown; this cost budget blocks new runs until a cost is reported';
    if (Number(sums.cost) >= limits.maxRecordedCostMicros) return 'Daily recorded cost limit reached';
  }
  return null;
}

export async function recordUsage(tx, attempt, task, body) {
  const data = body.data || {};
  if (data.currency !== undefined && data.currency !== 'USD') invalid('Recorded cost currency must be USD');
  if (data.currency !== undefined && data.costMicros === undefined) invalid('Currency requires a reported cost amount');
  if (typeof data.eventId !== 'string' || !data.eventId.trim() || data.eventId.length > 160 || !validCount(data.inputTokens) || !validCount(data.outputTokens)) invalid('Usage needs an event ID and bounded nonnegative token counts');
  const cached = data.cachedInputTokens ?? 0;
  if (!validCount(cached) || cached > data.inputTokens) invalid('Cached input tokens must be a subset of input tokens');
  if (data.costMicros !== undefined && data.costMicros !== null && !validCount(data.costMicros)) invalid('Recorded cost must be a nonnegative safe integer in micros');
  const prior = (await tx.query('SELECT input_tokens,output_tokens,cached_input_tokens,cost_micros FROM usage_events WHERE attempt_id=$1 AND event_id=$2', [attempt.id, data.eventId])).rows[0];
  if (prior) {
    const same = Number(prior.input_tokens) === data.inputTokens && Number(prior.output_tokens) === data.outputTokens && Number(prior.cached_input_tokens) === cached && (prior.cost_micros === null ? data.costMicros == null : Number(prior.cost_micros) === data.costMicros);
    if (!same) invalid('Usage event ID was already used for different measurements');
    return { duplicate: true };
  }
  const inserted = await tx.query('INSERT INTO usage_events(id,org_id,project_id,task_id,attempt_id,event_id,input_tokens,output_tokens,cached_input_tokens,cost_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(attempt_id,event_id) DO NOTHING RETURNING id', [randomUUID(), task.org_id, task.project_id, task.id, attempt.id, data.eventId, data.inputTokens, data.outputTokens, cached, data.costMicros ?? null]);
  if (inserted.rows.length) return { duplicate: false };
  const raced = (await tx.query('SELECT input_tokens,output_tokens,cached_input_tokens,cost_micros FROM usage_events WHERE attempt_id=$1 AND event_id=$2', [attempt.id, data.eventId])).rows[0];
  if (raced && Number(raced.input_tokens) === data.inputTokens && Number(raced.output_tokens) === data.outputTokens && Number(raced.cached_input_tokens) === cached && (raced.cost_micros === null ? data.costMicros == null : Number(raced.cost_micros) === data.costMicros)) return { duplicate: true };
  invalid('Usage event ID was already used for different measurements');
}
