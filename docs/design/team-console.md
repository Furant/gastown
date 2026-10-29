# Team Console — approved product design

Private deployment for multiple organizations, teams and members. Users' projects, tool connections and execution nodes are private by default; owners grant team or explicit-member access independently. A task grant never implicitly grants tool credentials or repository access. Tool credentials stay on nodes.

The console owns identity, authorization, plans, task states and audit records. Outbound execution nodes run locally authenticated Codex/Cursor CLIs. The UI exposes tool-specific model catalogs and reasoning modes discovered by each node, connection defaults, allowed-model restrictions and optional per-task overrides. Attempts snapshot settings; changing defaults does not change running work.

Task and execution-log read visibility inherits the project's explicitly shared scope. Reading shared work does not authorize use of its private tool connection: approval and transfer additionally require the actor's project, source connection and node permissions. Organization administrators can review organization-wide audit records; members see their own actions and events for resources they can view. Only a node's owner creates its local tool connections; distinct private tool accounts on a shared server require distinct OS identities/node processes.

Requirements confirmed with the user: private deployment; personal and shared server nodes; owner-preauthorized shared usage; human-approved implementation plans; parallel agents; observable evidence instead of guessed percentages; manual/automatic tool handoff; branch commits, pushes and PR creation authorized with plan approval; human merge only.

## First implementation milestone

Deliver a real persisted vertical slice: bootstrap/login, isolated users, teams/custom sharing, project and node registration, discovered tool connections, models/reasoning defaults, task creation, node-generated plan, human approval, outbound task claiming, execution events, stop-confirmed handoff and audit. A standalone `console/` package avoids changing the installed Go daemon. PostgreSQL is the deployment database; embedded PostgreSQL/PGlite supports local development and deterministic tests.

Same-node handoff preserves an isolated Git worktree and working changes. Cross-node handoff is rejected until a verified encrypted checkpoint transport is implemented; no pretending a different machine has the same files. Offline source nodes cannot be bypassed. Expired leases and unknown source state block recovery, never authorize duplicate writers. Node authorization and repository mappings are explicit. Sharing grants must be checked again on task claim, handoff and node events.

## State machine

`planning_queued -> planning -> awaiting_approval -> queued -> running -> awaiting_review -> completed`.

Failures preserve diagnostic events. `running -> stopping -> queued` is permitted only after the source process group is stopped and its worktree checkpoint acknowledged. A transfer snapshots the target connection's supported model/mode, never source-only flags. A failed or unacknowledged stop leaves the task blocked. Node polls return cancellation requests and only claim eligible jobs. A unique current attempt and authenticated attempt lease fence stale events.

## Security and acceptance

Password hashes use scrypt; random sessions are hashed in storage with HttpOnly SameSite cookies, CSRF protection and bounded bodies. Node tokens are shown once, hashed at rest, revocable and never sent to another user. Authorization uses authenticated organization and subject, not client-supplied owner IDs. User-controlled CLI arguments, executable paths and arbitrary shell endpoints are forbidden. Server defaults to loopback; private production deployment uses a TLS reverse proxy.

Tests must prove login and cross-user/org isolation, sharing without credential exposure, model/mode validation, human approval before execution, concurrent claims, stale-event fencing, stop acknowledgment before transfer and same-worktree continuation. Test workers use fixture binaries; no real paid models, repository pushes or PRs are used in automated tests.

## Component ownership and API contract

- `console/server/`: database, identity, authorization, REST API and scheduler.
- `console/node/`: registration-token polling worker, capability discovery, Git worktrees, process lifecycle and event reporting.
- `console/web/`: production frontend using API data; no seeded/demo data.
- `console/test/`, package metadata and deployment docs: integration and deployment.

API prefix `/api/v1`, JSON responses `{data: ...}` or `{error:{code,message}}`. Cookie user sessions; mutations require `X-CSRF-Token` obtained from `/auth/me`. Worker calls use `Authorization: Bearer <node-token>`.

User endpoints:

- `GET /auth/status -> {needsBootstrap}`; `POST /auth/bootstrap {organization,name,email,password}`; `POST /auth/login {email,password}` -> `{user,csrfToken}`; `GET /auth/me` -> `{user,csrfToken}`; `POST /auth/logout`.
- `GET/POST /members`: admin creates `{name,email,password}`; no public registration.
- `GET/POST /teams {name,memberIds}`.
- `GET/POST /projects {name,repoUrl,baseBranch,visibility,teamId?,memberIds?}`.
- `GET/POST /nodes {name,visibility,teamId?,memberIds?,projectIds}` -> created node plus one-time `token`; list excludes token hashes.
- `GET/POST /connections {name,nodeId,tool,visibility,teamId?,memberIds?,projectIds,model,mode,allowedModels,allowOverride,maxConcurrency,allowAutoFailover}`; `PATCH /connections/:id` owner edits. Catalogs come from node capability records. tools are `codex` or `cursor`.
- `GET /capabilities?nodeId=...`: `{tools:[{tool,models:[{id,name,modes,nativeByMode?}]}]}`.
- `GET/POST /tasks {title,description,projectId,connectionId,model?,mode?,autoFailover?}`: creation queues planning, never execution. Automatic failover defaults off and requires source and destination connection-owner opt-in, a process-group-stopped checkpoint and current grants. A connection already quota-blocked for this task is not automatically retried, so exhausting all candidates ends in a blocked task.
- `GET /tasks/:id` includes `plan`, `events`, `attempts`.
- `POST /tasks/:id/approve {allowPush,allowPR}`: snapshot approval of current plan and queue execution; PR merge is never authorized.
- `POST /tasks/:id/transfer {connectionId,model?,mode?}`: same-node only in milestone one; validate target, mark current source stopping. If already queued, switch safely before claiming.
- `GET /audit`: visible user-relevant audit records.

Worker endpoints:

- `POST /worker/heartbeat {capabilities:{tools:[...]}}` -> node info. Node id determined from token.
- `POST /worker/poll {capacity?:integer}` -> `{jobs:[job],cancellations:[{attemptId}]}`; zero capacity only retrieves cancellations and never claims. Jobs are bounded by requested capacity and connection limits. Claim uses a database transaction and rechecks grants. The node retains the original job lease token; the server stores only its hash.
- Job: `{attemptId,leaseToken,kind:'plan'|'execute',taskId,projectId,title,description,plan,connectionId,tool,model,mode,nativeModel,allowPush,allowPR}`. Repository path is never provided by server; resolve projectId through node-local config.
- `POST /worker/events {attemptId,leaseToken,type,message,data?}` with types `log`, `plan_ready` (data `{steps:[{title,acceptance}],summary}`), `completed` (data `{branch,prUrl?,summary}`), `failed`, `quota_exhausted`, `stopped` (data `{checkpoint:{branch,worktree,dirty}}`). Events are size bounded. Only active authenticated attempts may mutate task state; `stopped` is accepted only when stop requested. Node transport must redact secrets and bound output.

Frontend reads all supported model options from authenticated node capabilities. An empty database renders onboarding; no sample credentials or tasks. Do not expose stored lease tokens through user endpoints.
