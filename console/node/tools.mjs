const codexEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const cursorEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const cursorSuffix = /-(none|low|medium|high|xhigh|max)(?:-fast)?$/;

export function codexCapabilities(models) {
  if (!Array.isArray(models)) return [];
  return models.filter(m => typeof m?.slug === 'string' && Array.isArray(m.supported_reasoning_levels))
    .map(m => ({ id: m.slug, name: m.display_name || m.slug, modes: m.supported_reasoning_levels.map(x => x.effort).filter(x => codexEfforts.has(x)), nativeByMode: Object.fromEntries(m.supported_reasoning_levels.map(x => [x.effort, m.slug])) }))
    .filter(m => m.modes.length);
}

export function cursorCapabilities(lines) {
  const models = new Map();
  for (const line of lines) {
    const match = line.trim().match(/^([\w.:-]+)\s+-\s+(.+)$/);
    if (!match) continue;
    const [, id, name] = match;
    const suffix = id.match(cursorSuffix);
    const base = suffix ? id.slice(0, -suffix[0].length) : id;
    const mode = suffix?.[1] || 'auto';
    if (!cursorEfforts.has(mode) && mode !== 'auto') continue;
    const entry = models.get(base) || { id: base, name: suffix ? name.replace(/\s+(?:None|Low|Medium|High|Extra High|Max)(?:\s+Fast)?$/i, '') : name, modes: [], nativeByMode: {} };
    if (!entry.nativeByMode[mode] || !id.endsWith('-fast')) entry.nativeByMode[mode] = id;
    if (!entry.modes.includes(mode)) entry.modes.push(mode);
    models.set(base, entry);
  }
  return [...models.values()].map(m => ({ ...m, modes: m.modes.sort((a, b) => effortOrder(a) - effortOrder(b)) }));
}

function effortOrder(mode) { return ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].indexOf(mode); }

function validateModel(job, config) {
  const models = config.capabilities?.tools?.[job.tool]?.models || [];
  const model = models.find(m => m.id === job.model);
  if (models.length && (!model || !model.modes.includes(job.mode))) throw new Error('Unsupported model or reasoning mode from node capability catalog');
  if (!models.length) {
    if (job.tool === 'codex' && (!codexEfforts.has(job.mode) || !job.model)) throw new Error('Unsupported model or reasoning mode');
    if (job.tool === 'cursor' && (!cursorEfforts.has(job.mode) || !job.nativeModel)) throw new Error('Unsupported model or reasoning mode');
  }
  if (job.tool === 'cursor' && model && model.nativeByMode?.[job.mode] !== job.nativeModel) throw new Error('Unsupported Cursor model variant');
}

export function buildInvocation(job, config) {
  if (!['codex', 'cursor'].includes(job.tool) || !['plan', 'execute'].includes(job.kind) || typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('Invalid typed tool job');
  const entry = config[job.tool];
  if (!entry || typeof entry.command !== 'string' || !entry.command.trim()) throw new Error(`No configured ${job.tool} CLI`);
  validateModel(job, config);
  if (job.tool === 'codex') {
    const args = ['exec', '--json', '--sandbox', job.kind === 'plan' ? 'read-only' : 'workspace-write', '--model', job.model, '-c', `model_reasoning_effort="${job.mode}"`, job.prompt];
    return { command: entry.command, args, cwd: job.cwd, shell: false };
  }
  const mode = job.kind === 'plan' ? ['--mode', 'ask'] : [];
  const args = [...mode, '--print', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust', '--model', job.nativeModel, job.prompt];
  return { command: entry.command, args, cwd: job.cwd, shell: false };
}

export function parsePlan(value) {
  let input = value.trim();
  if (input.startsWith('```')) input = input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(input); }
  catch {
    const start = input.indexOf('{'), end = input.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Agent did not return a valid JSON plan');
    try { parsed = JSON.parse(input.slice(start, end + 1)); } catch { throw new Error('Agent did not return a valid JSON plan'); }
  }
  if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.length > 2000 || !Array.isArray(parsed.steps) || parsed.steps.length < 1 || parsed.steps.length > 12) throw new Error('Plan must contain a summary and 1-12 steps');
  const steps = parsed.steps.map(step => {
    if (!step || typeof step.title !== 'string' || !step.title.trim() || step.title.length > 120 || typeof step.acceptance !== 'string' || !step.acceptance.trim() || step.acceptance.length > 500) throw new Error('Each plan step needs a short title and acceptance condition');
    return { title: step.title.trim(), acceptance: step.acceptance.trim() };
  });
  return { summary: parsed.summary.slice(0, 2000), steps };
}

export function parseCodexCatalog(cache) {
  const models = Array.isArray(cache) ? cache : cache?.models;
  return codexCapabilities(models);
}
