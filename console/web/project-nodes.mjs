export function projectNodeSelection(project, nodes = [], ownerId) {
  const local = project?.repoType === 'local';
  const ids = new Set(local ? [project.localNodeId].filter(Boolean) : (project?.nodeIds || []));
  const eligible = nodes.filter(node => local
    ? node.id === project.localNodeId && node.ownerId === ownerId && node.pairedToThisDevice && !node.revokedAt
    : !node.revokedAt && (node.ownerId === ownerId || node.visibility !== 'private'));
  const visibleIds = new Set(eligible.map(node => node.id));
  return {
    options: eligible.map(node => ({ id: node.id, name: node.name || node.id, selected: ids.has(node.id), locked: local })),
    retainedNodeIds: local ? [] : [...ids].filter(id => !visibleIds.has(id)),
  };
}

export function projectNodePatchBody(values) {
  const submitted = Array.isArray(values?.nodeIds) ? values.nodeIds : [];
  return { nodeIds: [...new Set(submitted)] };
}
