import { nodeProjectIds } from './onboarding.mjs';

export function nodeEditProjectSelection(node, projects = []) {
  const grants = new Set(nodeProjectIds(node));
  const nodeId = node?.id ?? node?.nodeId;
  const visible = projects.map(project => ({ project, id: project.id ?? project.projectId }))
    .filter(({ project }) => project.repoType !== 'local' || project.localNodeId === nodeId);
  const visibleIds = new Set(visible.map(({ id }) => id));
  return {
    options: visible.map(({ project, id }) => ({
      id,
      name: project.name || id,
      selected: grants.has(id),
      locked: project.repoType === 'local' && project.localNodeId === nodeId,
    })),
    retainedGrantIds: [...grants].filter(id => !visibleIds.has(id)),
  };
}

export function mergeNodeEditProjectIds(node, selectedIds, projects = []) {
  const selection = nodeEditProjectSelection(node, projects);
  return [...new Set([
    ...(Array.isArray(selectedIds) ? selectedIds : []),
    ...selection.retainedGrantIds,
    ...selection.options.filter(option => option.locked && option.selected).map(option => option.id),
  ])];
}

export function nodeEditPatchBody(values, node, projects = []) {
  const body = { name: values.name, visibility: values.visibility };
  if (values.visibility === 'team') body.teamId = values.teamId;
  if (values.visibility === 'custom') body.memberIds = Array.isArray(values.memberIds) ? values.memberIds : [];
  body.projectIds = mergeNodeEditProjectIds(node, values.projectIds, projects);
  return body;
}
