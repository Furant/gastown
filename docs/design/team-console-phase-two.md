# Team Console phase two — parallel implementation plan

Approved by the user on 2026-10-29: advance task controls, multi-agent task decomposition, cross-node checkpoint recovery and real-CLI compatibility checks in parallel. Continue on `codex/team-console`; preserve the existing live data and code. Track work with Beads, not Markdown task lists.

## Ownership and sequencing

1. Server owner: `console/server/**`. Test lifecycle transitions, owner/use grants, acyclic workflow validation, dependency scheduling, encrypted checkpoint storage and replay prevention before implementation.
2. Node owner: `console/node/**`. Test pause/cancel stop acknowledgment, encrypted export/import, source process fencing, wrong recipient/digest rejection, safe Git worktree restore and read-only CLI preflight.
3. Frontend owner: `console/web/**`. Add actual API-backed task controls, child-task creation/dependencies/progress, and cross-node transfer eligibility; show unsupported or blocked operations honestly.
4. Root: shared checkpoint cryptography under `console/shared/**`, HTTP/process integration tests, docs, final review, migration and deployment verification.

## Lifecycle API

`POST /api/v1/tasks/:id/pause`, `/resume`, `/cancel`, `/retry`; mutations require CSRF plus independent task-operation authorization. Active attempts receive `stop_requested`; task remains `stopping` until its process-group-stopped checkpoint is acknowledged. Queued jobs can pause/cancel atomically. Resume/retry preserves existing worktree; a retry explicitly starts a new quota-failover generation. Terminal canceled work never automatically resumes. Worker cancellations include `{attemptId,reason:'pause'|'cancel'|'transfer'}`; `stopped` events use server-recorded intent, never worker-provided permission escalation.

## Multi-agent workflows

`POST /api/v1/tasks/:id/decompose {children:[{key,title,description,connectionId,dependsOn:[key]}]}` accepts 1–12 uniquely keyed child tasks and an acyclic dependency graph. It is a human-reviewed decomposition of the parent's plan and requires authorization for every selected connection/node/project. Child plans reuse the accepted parent plan boundaries; parent approval starts the workflow and snapshots push/PR grants. Distinct tasks always use distinct worktrees. Polling releases children only when prerequisites have successful verifiable results; paused/failed/canceled dependencies block descendants. Parent detail includes children, dependency edges and factual statuses. A parent does not report complete while a child failed or is pending human review.

Dependency results (summaries, branches, PR evidence) are explicitly passed to downstream agents as context. This milestone does not silently merge independently edited branches. Code integration must be part of an explicit child plan, with conflicts surfaced as failures requiring review. The UI must state that task dependencies determine scheduling; a dependency edge alone is not a code merge.

## Cross-node checkpoint protocol

Each node persists a private X25519 key pair locally with 0600 permissions and reports `checkpointPublicKey` on heartbeat. The console only stores the public key. A transfer requires fresh target heartbeat, target key, project authorization and connection/model access. A source that cannot acknowledge stopping cannot be bypassed.

Transfer intent includes a server-generated `transferId`. Source cancellation includes `handoff:{transferId,targetNodeId,targetPublicKey}`. After stopping the whole source process group, the source builds a bounded Git checkpoint containing the current HEAD and safe tracked/untracked work, without altering its index or branch. Ignored files and credential-like paths must not be exported; reject ambiguous/sensitive cases rather than silently lose work. No execution credentials or absolute source paths are in checkpoint contents.

`POST /api/v1/worker/checkpoints` accepts `{attemptId,leaseToken,transferId,envelope}` under the source node token, verifies current transfer/source/target bindings, stores only ciphertext and returns `{checkpointId,digest}`. This endpoint has a separately bounded body (maximum 16 MiB JSON); ordinary APIs retain their smaller limit. The `stopped` event references `checkpointId` and `digest`; only then can the target queue. Target claim includes a checkpoint descriptor and retrieves the envelope through `POST /api/v1/worker/checkpoints/:id/read {attemptId,leaseToken}`. Return ciphertext only to the authenticated target's current leased attempt; never expose it via user task detail.

The root shared module exports `generateCheckpointKeys() -> {privateKey,publicKey}`, `sealCheckpoint(bytes,publicKey,context) -> envelope`, and `openCheckpoint(envelope,privateKey,expectedContext) -> Buffer`. Context is exactly `{taskId,projectId,sourceAttemptId,targetNodeId,transferId}`. X25519 + HKDF-SHA256 + AES-256-GCM binds context as authenticated data; malformed keys, wrong target/context, tampering and oversized payloads fail closed. `checkpointDigest(envelope)` authenticates transfer references. Node keys never go to the server.

The target verifies/decrypts/imports before starting the CLI. Restore to a new isolated task worktree, verify the expected source HEAD and checkpoint commit/tree, retain source modifications as dirty changes, and reject an unrelated pre-existing task worktree. Never reset or clean the user's checkout. Failures leave task blocked/failed with the source checkpoint intact; replay by a stale attempt is rejected. Automatic quota fallback remains same-node unless explicitly extended and independently verified.

## Validation

Run unit tests first, HTTP + real fixture-process integration tests for lifecycle/DAG and two-node recovery, negative crypto/path/authorization tests, syntax checks, dependency audit, and independent security review. Real provider checks are read-only (`--help`, model discovery and `--check`) unless the user explicitly authorizes a paid execution. No test pushes a real repository or merges a PR. Preserve and migrate the live PostgreSQL data before restarting the console; commit and push only after successful verification.
