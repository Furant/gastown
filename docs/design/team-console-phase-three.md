# Phase three — recovery, membership and recorded-usage budgets

The user requested the local frontend/API be refreshed first, then development continue. The review service at port 8770 serves the validated `f4612174` web snapshot and existing data; development tests must use independent temporary databases. Continue in the existing feature worktree and leave provider credentials untouched.

## Parallel ownership

Server owner: `console/server/**` adds membership lifecycle, project budgets, idempotent usage events and authenticated worker recovery. Node owner: `console/node/**` adds protected execution journals, verified orphan shutdown and actual CLI usage extraction. Frontend owner: `console/web/**` adds members/teams management, project budget and recorded usage views, and recovery-required status. Root handles integration tests, deployment scripts/docs, security review and release verification.

## Membership

`PATCH /api/v1/members/:id {name?,role?,disabled?}` is admin-only. Do not allow self-disable, removal of the last enabled administrator, or cross-organization IDs. Disabling invalidates the member's sessions and prevents their node credentials, task claims and tool-use grants from authorizing further work; active owned nodes stop on authorization loss. Retain task history and audit records. `POST /api/v1/members/:id/reset-password {password}` is admin-only, requires a fresh generated password from the operator, hashes it and invalidates existing sessions. `POST /api/v1/auth/change-password {currentPassword,newPassword}` verifies the old password and invalidates other sessions; no email is sent. `PATCH /api/v1/teams/:id {name?,memberIds?}` requires team owner/admin and validates same-org members. No public signup, emailed invitations, SSO or MFA is claimed by this milestone.

## Recorded usage and budgets

Workers may send `type:'usage'`, `data:{eventId,inputTokens,outputTokens,cachedInputTokens?,costMicros?}`. A stable per-attempt eventId deduplicates retries. Counts must be bounded nonnegative integers; cached input is a subset of input. Cost is optional and is stored only when reported by the tool; never fabricate currency prices from subscription names. Scope and lease checks are identical to other attempt events. Node redaction and task history must not disclose credentials.

`GET /api/v1/usage?projectId=...` returns visible aggregated actual counts, run count and known/unknown cost coverage. `GET/PUT /api/v1/projects/:id/budget` permits project owner/admin to set `{enabled,maxRunsPerDay?,maxInputTokens?,maxOutputTokens?,maxRecordedCostMicros?}`. Limits apply to recorded usage in the current UTC day (show this timezone explicitly). All planning and implementation claims count as runs. Transactional claims recheck budgets so maxRuns cannot be oversubscribed under concurrency; denied work remains queued with an explicit budget-block reason. A cost-only budget with no cost observations fails closed until disabled or changed to a measured metric. Do not market these as provider account balances or guaranteed real-time spending caps: in-flight provider usage can exceed a threshold before the next event arrives. Usage data may be incomplete after abrupt process loss; show missing cost/usage as unknown.

## Restart recovery

Persist per-attempt journals locally with 0600 permissions outside task worktrees. Node credentials and attempt leases must never appear in CLI output, source archives, checkpoints or server list responses. Journal phases distinguish preparation, owned process identity, checkpoint and accepted terminal event. Before launching new jobs, examine unresolved records. Kill only a provably matching locally owned process group (PID plus start identity and unique supervisor/job identity); a recycled or unverifiable PID never authorizes a kill or restart. A preparation/spawn uncertainty remains blocked for explicit investigation. Do not clear another worker's active journal.

`POST /api/v1/worker/recover {attemptId,leaseToken,outcome:'stopped'|'unknown',checkpoint?,message?}` authenticates the same node and current attempt. Confirmed stopped work becomes paused with its approved plan retained, not automatically re-executed. Unknown source state becomes `recovery_required`, retains its fencing lease, and cannot be retried automatically. Stale/revoked attempts cannot requeue a task. If a pending pause/cancel/transfer intent exists, retain that intent and use the existing stop/checkpoint protocol; do not silently discard a transfer. Source code/worktrees remain intact. Existing pre-journal attempts are not claimed to be automatically recoverable.

## Validation and delivery

First write regressions for member disable/session invalidation, last-admin safety, cross-org access, shared-use revocation, repeated usage events, budget exhaustion/concurrent claims, process identity mismatch and no duplicate launch after restart. Use temporary repositories/databases and fixture processes. No paid model execution, real PR push or third-party messages. Run all tests, syntax/dependency checks, independent review and source secret scan before commit/push. Existing review data is backed up before migration and restarted only after validation; no untested frontend changes are served directly to the user's review snapshot.
