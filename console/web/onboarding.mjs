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

export function validateNodeConfig(config) {
  const errors = [];
  if (!isControlPlaneUrlAllowed(config?.serverUrl)) errors.push('serverUrl');
  const projects = Object.values(config?.projects || {});
  if (!projects.length || projects.some(project => !isAbsoluteNodePath(project.repoPath) || !project.baseBranch?.trim())) errors.push('projects');
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
