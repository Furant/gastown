# Team Console implementation plan

**Goal:** Deliver a runnable, persisted private team console with an outbound execution node and stop-confirmed task transfer.

**Architecture:** Independent Node 24 package, PostgreSQL API, API-backed frontend, outbound node. Existing Go CLI and running installation remain unchanged. Node-local tool adapters execute known CLIs with typed parameters.

**Tracking:** Beads `gtf-hrf`. Implementation follows the explicit API contract in `team-console.md`; no production capability is represented by simulated success.

## 1. Identity, persistence and authorization

Files: `console/server/{db,auth,access,api,scheduler,index}.mjs` and server tests. First write and run failing tests for bootstrap/session, cross-user privacy, organization scoping, sharing and model validation. Implement migrations, transactional claims and stop acknowledgment gates. Run `npm test -- --test-name-pattern=...` as appropriate; exact standard command is `npm test` using Node's test runner.

## 2. Outbound node and tool adapters

Files: `console/node/{index,client,runner,tools,workspace}.mjs` and node tests. First tests assert no execution before approval, shell-free CLI argument mapping, workspace containment, process-stop ordering and preserved dirty worktree. Implement capability discovery, bounded events, signal handling and durable same-task worktree lookup. Fixture tools only in tests.

## 3. API-backed interface

Files: `console/web/{index.html,app.js,styles.css}`. Implement bootstrap/login, project/team/node setup, one-time token handoff, connection/model settings and task plan/execute/transfer views. Do not embed prototype fixture records. UI must display unsupported operations and errors honestly; default values never override owner restrictions.

## 4. Integration and deployment

Files: `console/{package.json,package-lock.json,Dockerfile,compose.yaml,.env.example,README.md}`, `console/test/`. Start embedded PostgreSQL for local development and tests. Standard PostgreSQL for server deployment. Run all tests, coverage, syntax checks, dependency audit, and independent correctness/security review. Build and open the local real frontend; verify bootstrap and login without launching paid tool jobs.

## 5. Review and delivery

Review diffs for credentials and authorization boundaries. Keep actual execution disabled until a user registers a node and explicitly maps local repositories. Report verified capabilities and remaining cross-node/automatic-policy work separately. Commit and push this feature branch only after checks; use the already authorized per-invocation ECC pre-push skip to avoid unsafe global test-hook environment leakage.
