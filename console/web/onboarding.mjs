export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function isAbsoluteNodePath(value) {
  return typeof value === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(value.trim());
}

export function isControlPlaneUrlAllowed(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function getLocalDeviceSecret(storage = globalThis.localStorage, cryptoApi = globalThis.crypto) {
  const key = 'gastown.local-device.v1';
  let value;
  try { value = storage?.getItem(key); } catch { value = ''; }
  if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
  if (!cryptoApi?.getRandomValues) throw new Error('此浏览器无法生成安全的本机配对凭据。');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  try { storage?.setItem(key, value); } catch { /* Keep this browser-session key in memory when storage is unavailable. */ }
  return value;
}

export function buildNodeConfig({ serverUrl, projects, cliPaths }) {
  return {
    serverUrl: String(serverUrl ?? '').trim(),
    projects: Object.fromEntries((projects || []).map(project => [String(project.id), {
      repoPath: String(project.repoPath ?? '').trim(),
      baseBranch: String(project.baseBranch || 'main').trim(),
    }])),
    tools: Object.fromEntries(['codex', 'cursor'].flatMap(tool => {
      const command = String(cliPaths?.[tool] ?? '').trim();
      return command ? [[tool, { command }]] : [];
    })),
  };
}

export function nodeProjectIds(values) {
  return Array.isArray(values?.projectIds) ? [...values.projectIds] : [];
}

export function renderAllowedModelChoices(models, allowedModels) {
  return models.map(model => {
    const selected = !allowedModels?.length || allowedModels.includes(model.id);
    return `<label class="check"><input type="checkbox" name="allowedModels" value="${escapeHTML(model.id)}" ${selected ? 'checked' : ''}>允许任务使用 ${escapeHTML(model.name)}</label>`;
  }).join('');
}

export function shellQuoteNodePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\0\r\n]/.test(value) || !isAbsoluteNodePath(value)) throw new Error('请填写不含换行的绝对路径。');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildNodeCommand({ consoleDir, configPath, mode = 'start' } = {}) {
  const modes = { pair: '--pair', check: '--check', 'sync-config': '--sync-config', start: '' };
  if (!Object.hasOwn(modes, mode)) throw new Error('不支持的节点命令模式。');
  return `npm --prefix ${shellQuoteNodePath(consoleDir)} run node -- --config ${shellQuoteNodePath(configPath)}${modes[mode] ? ` ${modes[mode]}` : ''}`;
}

export function buildNodeSetupCommand({ consoleDir, configPath, mode = 'start' } = {}) {
  const config = shellQuoteNodePath(configPath);
  const command = buildNodeCommand({ consoleDir, configPath, mode });
  const secureToken = `if [ -z "\${GAS_TOWN_NODE_TOKEN:-}" ]; then printf '%s' 'GAS_TOWN_NODE_TOKEN: '; IFS= read -r -s GAS_TOWN_NODE_TOKEN; printf '\\n'; fi; export GAS_TOWN_NODE_TOKEN; `;
  return `(\nset -e\nif [ ! -f ${config} ]; then printf '%s\\n' 'node-config.json was not found at the configured path.' >&2; exit 1; fi\nchmod 600 ${config}\n${secureToken}${command}\n)`;
}

export function validNodeCommandPaths(paths) {
  try { shellQuoteNodePath(paths?.consoleDir); shellQuoteNodePath(paths?.configPath); return true; }
  catch { return false; }
}

export function nodePathPreferenceKey(ownerId, nodeId) {
  if (!ownerId || !nodeId) return '';
  return `gastown.node-paths.v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(nodeId)}`;
}

export function readNodePathPreferences(storage, ownerId, nodeId) {
  const key = nodePathPreferenceKey(ownerId, nodeId);
  try { const value = key ? JSON.parse(storage?.getItem(key) || '{}') : {}; return { consoleDir: value.consoleDir || '', configPath: value.configPath || '' }; }
  catch { return { consoleDir: '', configPath: '' }; }
}

export function saveNodePathPreferences(storage, ownerId, nodeId, paths) {
  const key = nodePathPreferenceKey(ownerId, nodeId);
  if (!key) return false;
  try { storage?.setItem(key, JSON.stringify({ consoleDir: paths?.consoleDir || '', configPath: paths?.configPath || '' })); return true; }
  catch { return false; }
}

export function freshWorkspaceState(previousState) {
  const deviceSecret = typeof previousState === 'object' ? previousState?.deviceSecret : previousState;
  return {
    page: 'tasks', user: null, csrf: '', deviceSecret,
    items: { projects: [], tasks: [], connections: [], nodes: [], members: [], teams: [], audit: [] },
    capabilities: null, detail: null, busy: false, filter: 'all', search: '', modal: null,
    bootstrap: false, tab: 'all', toolFilter: 'all', selected: new Set(), detailTab: 'plan',
    transferIds: [], nodeSetup: null, selectedNode: null, pairingCode: null, usageProject: null,
    usageData: null, budgetProject: null, budgetData: null, localProjectDraft: null,
  };
}

export function createSessionEpochGuard() {
  let epoch = 0;
  return {
    capture: () => epoch,
    advance: () => ++epoch,
    assertCurrent(requestEpoch) {
      if (requestEpoch !== epoch) throw new Error('会话已切换，请重试。');
    },
  };
}

export function validateNodeConfig(config) {
  const errors = [];
  if (!isControlPlaneUrlAllowed(config?.serverUrl)) errors.push('serverUrl');
  const projectMap = config?.projects;
  const validProjectMap = !!projectMap && typeof projectMap === 'object' && !Array.isArray(projectMap);
  const projects = validProjectMap ? Object.values(projectMap) : [];
  if (!validProjectMap || projects.some(project => !project || typeof project !== 'object' || Array.isArray(project) || !isAbsoluteNodePath(project.repoPath) || typeof project.baseBranch !== 'string' || !project.baseBranch.trim())) errors.push('projects');
  const tools = Object.values(config?.tools || {});
  if (!tools.length || tools.some(tool => !isAbsoluteNodePath(tool.command))) errors.push('tools');
  return { valid: errors.length === 0, errors };
}

export function nodeStatus(node) {
  if (node?.revokedAt) return 'offline';
  if (!node?.onlineAt) return 'pending';
  if (node.status === 'waiting' || node.status === 'pending') return 'pending';
  return node.status || 'offline';
}

export function githubPrUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}
