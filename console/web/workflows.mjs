export function taskLifecycleActions(status) {
  return ({
    running: ['pause', 'cancel'],
    queued: ['pause', 'cancel'],
    planning: ['pause', 'cancel'],
    planning_queued: ['pause', 'cancel'],
    awaiting_approval: ['cancel'],
    paused: ['resume', 'cancel'],
    orchestrating: ['pause', 'cancel'],
    failed: ['retry'],
    quota_blocked: ['retry'],
    canceled: ['retry'],
    stopping: [],
  })[status] || [];
}

export function validateChildren(children) {
  if (!Array.isArray(children) || children.length < 1 || children.length > 12) return '请添加 1 到 12 个子任务。';
  const keys = children.map(child => child.key?.trim());
  if (keys.some(key => !key || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(key))) return '子任务标识必须以字母或数字开头，后续可使用字母、数字、下划线或连字符，最多 48 位。';
  if (new Set(keys).size !== keys.length) return '子任务标识不能重复。';
  if (children.some(child => !child.title?.trim() || !child.description?.trim() || !child.connectionId)) return '每个子任务都需要标题、任务说明和执行连接。';
  const byKey = new Map(children.map((child, index) => [keys[index], child]));
  if (children.some((child, index) => (child.dependsOn || []).some(key => !byKey.has(key?.trim()) || key?.trim() === keys[index]))) return '依赖必须指向其他已定义的子任务。';
  const visited = new Set(); const active = new Set();
  function visit(key) {
    if (active.has(key)) return false;
    if (visited.has(key)) return true;
    active.add(key);
    for (const dependency of byKey.get(key).dependsOn || []) if (!visit(dependency.trim())) return false;
    active.delete(key); visited.add(key); return true;
  }
  return keys.every(visit) ? '' : '依赖关系形成了循环，请调整后再提交。';
}

export function checkpointTargetReady(node, now = Date.now()) {
  if (!node || node.status !== 'online') return { ready: false, reason: '目标节点离线。' };
  if (!node.checkpointPublicKeyPresent) return { ready: false, reason: '目标节点尚未上报检查点公钥。' };
  const heartbeat = Date.parse(node.lastHeartbeatAt || node.heartbeatAt || node.onlineAt || '');
  if (!Number.isFinite(heartbeat) || now - heartbeat > 45_000 || heartbeat > now + 5_000) return { ready: false, reason: '目标节点心跳已过期。' };
  return { ready: true, reason: '' };
}
