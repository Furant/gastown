# Gas Town Team Console

A private team control plane and outbound execution node, developed independently of the existing Go `gt` daemon. Tool credentials stay on the machine running the tools. Do not confuse this application with the earlier mock prototype.

## Run locally

Requires Node.js 24 or later, npm, and Git on execution nodes. From `console/`:

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8770>. The first visitor creates the organization and administrator. The control plane contains no default accounts, passwords, sample projects or tool credentials. Local development uses embedded PostgreSQL/PGlite in `.data/`; data survives restarts. This local mode is intended for one development server process. Use PostgreSQL for team deployment.

Node registration is an invitation for an outbound worker, not a remote installation command. The web form does not need a node IP or listening port because nodes do not accept inbound control connections. Each node needs a reachable **console URL** and its own registration token. `127.0.0.1:8770` works only when the node and console run on the same machine. A node on a different machine must use your deployed HTTPS console address; registering a name does not make a loopback-only console reachable remotely.

The prototype at port 8768 is a separate, simulated artifact; it does not control this application.

## Private server deployment

Create `console/.env`, generate a fresh database password, and keep this file out of version control:

```sh
openssl rand -hex 32
```

Put the generated value in `.env` as `POSTGRES_PASSWORD=<generated-value>`, then:

```sh
docker compose up --build -d
```

The compose file publishes the console to server loopback only. Place it behind your organization's authenticated TLS reverse proxy before exposing it to teammates. Set `COOKIE_SECURE=1` for HTTPS. The database is not published. Alternatively, set `DATABASE_URL` and run `npm start`. PostgreSQL migrations run on startup. Do not run multiple embedded database processes against one data directory.

## Register an execution node

1. Register a standalone node with its name and visibility. Copy its token once; the server stores only its hash.
2. Create or edit a project and select its execution nodes. Several projects may use the same node; a remote project may select multiple nodes. A project with no nodes selected cannot execute tasks yet.
3. On that machine, create a protected `node-config.json`, mapping the console project ID to a local repository:

```json
{
  "serverUrl": "http://127.0.0.1:8770",
  "projects": {
    "<project-id-from-console>": {
      "repoPath": "/absolute/path/to/repository",
      "baseBranch": "main"
    }
  },
  "tools": {
    "codex": { "command": "/absolute/path/to/codex" },
    "cursor": { "command": "/absolute/path/to/cursor-agent" }
  }
}
```

```sh
chmod 600 node-config.json
read -rs GAS_TOWN_NODE_TOKEN
export GAS_TOWN_NODE_TOKEN
npm run node -- --config "$PWD/node-config.json" --check
npm run node -- --config "$PWD/node-config.json"
```

Use `read -s GAS_TOWN_NODE_TOKEN` in zsh; the `read -rs` example is for bash. The token can alternatively be entered into the protected local config as `token`, with the same file permissions. Copied setup commands prompt only when neither the environment nor the protected config contains a valid-length token; a pairing code is entered separately and cannot replace the node token.

Compatible execution nodes automatically report their installed console directory and loaded config file path during startup and `--check`. Node owners see these actual paths prefilled in node details, including remote machine paths; shared viewers and other administrators do not receive them. Offline nodes retain the last report with its timestamp. Explicit manual overrides remain local to that owner/browser/node and can be reset with **Use node-reported paths**. Older workers must restart with the updated code before reporting paths. A never-connected machine cannot be inspected by the browser: its first setup still needs to run on that machine; the console does not scan disks or guess remote directories.

Run these commands from the `console/` directory of this feature's checkout after `npm ci`. Preflight (`--check`) verifies the configured server, authorization, repositories, executable paths and model catalogs and sends a heartbeat; it never polls for or executes tasks. Starting without `--check` begins the worker loop. A registered node is waiting until its first heartbeat, online while heartbeats are fresh, and offline once they expire. If the one-time token is lost, revoke the old node and register a new one; the console cannot recover its plaintext token.

Use the actual base branch of the local repository. Login to each CLI on the execution machine beforehand; never upload provider login files to the control plane. Configure only tools you intend to use. The worker polls outbound, discovers capabilities and reports actual events. Local tool/config paths are not supplied by web task payloads.

One node uses one local OS identity and its tool logins. Only its owner creates connections on it; teammates use explicitly shared connections. To host members' separate private tool accounts on a shared server, run separate node processes under separate OS users/isolated homes and repository access. Sharing a server entry in the console does not create OS isolation or independent provider logins. Node protocol/HTTP authorization cannot substitute for this boundary.

## Private local development

Private projects can use a local Git directory instead of a GitHub URL. Here, local means your own development computer, even when the console is hosted on a team server. The local-project form lists your existing nodes, including those that still need pairing. Select the computer you are using and choose **Pair selected node**; generate a code, run the displayed command on that computer, then refresh pairing status to return to the preserved project name, directory and branch. Canceling the pairing dialog also preserves the draft. Register a new node only when you do not already own one. Shared nodes owned by other members are not eligible for private local projects. Being online is separate from pairing this browser, and project saving stays disabled until the selected node is paired. Initial node registration and configuration download work with no projects (`projects: {}`). Configure at least one installed CLI, download the token-free JSON, and use the one-time node token on that computer to run the displayed `--pair` command, then enter the pairing code at its interactive prompt. Refresh pairing status in the wizard and return to the preserved project form. Pairing codes expire after five minutes and can be used once. This explicitly associates the node with this browser's device secret; it is an operator-selected machine binding, not hardware attestation. Keep node credentials on that machine. Copying a node's credentials to another machine defeats that binding.

Create the local project with its absolute Git root, base branch and paired node. Run the configuration synchronization command below to add the new project mapping automatically, then restart the worker. Directory existence, Git root and base branch are checked on the node before launching a tool. The console never opens that path on its server. The directory must already be a Git repository; the worker does not initialize or reset it.

Local projects stay private and execute only on the bound owner node. Tool switching can use another authorized connection on that same node. Other nodes cannot receive those tasks or encrypted checkpoints, and an offline local node leaves work waiting. Local project tasks cannot authorize automatic commits, pushes or PRs.

New local tasks execute directly in the configured Git directory on the selected working branch. The task detail shows that original directory, a copy action, a Cursor opening link and a bounded changed-file/diff report. Your usual IDE sees the modifications immediately. Existing staged, unstaged and untracked changes are preserved; directory diff may include your earlier edits. Same-directory tasks run in sequence. A clean repository may switch to the selected branch; a dirty repository on a different branch, detached HEAD or unresolved merge blocks execution rather than discarding changes. Historical tasks retain their original isolated worktree and output; they are never copied back automatically. Sensitive, binary and symlink content is omitted from the web report, and truncation is marked. Review the complete worktree locally before deciding to merge, commit or push. Reported tool summaries are not independent proof that tests passed. Local review content and paths are restricted to the owner and paired browser. Keep browser storage available; losing the device secret may require recreating the binding rather than silently moving an existing local project.

## Task lifecycle and sharing

Connections and projects start private. Owners may separately share them with a team or explicit members. Projects select execution nodes; nodes do not maintain project grants. A user needs project, selected node and connection access; sharing a task alone grants no tool credentials. Configure a connection only after its node reports tool models. Models and reasoning modes are validated against the connection's catalog and owner restrictions. Attempts snapshot their configuration.

Creating a task queues a planning job. An execution node calls the selected CLI in planning mode. Review the returned plan and explicitly approve execution, commits/push and PR creation. No task receives merge authorization. Observe task events and errors in the task detail view.

Manual transfer checks target permissions and uses target model settings. For an active source, the task enters `stopping`; the node must terminate the original process group and acknowledge a worktree checkpoint before the target can be claimed. A missing stop acknowledgment does not permit a second writer. Both same-node and explicitly requested cross-node transfers are supported, subject to the checkpoint constraints below.

Automatic same-node quota handoff is opt-in for each task and both source/target connections. It requires a structured tool quota error, a verified stopped process group, a worktree checkpoint and currently valid permissions. Each exhausted connection is excluded from automatic retries for that task, preventing a loop between exhausted accounts. When no eligible connection remains, the task stays blocked for human intervention. Ordinary network errors and quoted quota messages do not trigger a switch. PR-authorized jobs report success only after `gh pr view` verifies the PR belongs to the expected repository and task/base branches; install and authenticate GitHub CLI on nodes where PR delivery is enabled.

Remote tasks and historical local tasks keep a task Git worktree for continuation. New local tasks use their original mapped directory. The worker does not reset or clean the user's checkout. Repository pushes and PR creation may incur external side effects only after task approval permits them. The console does not approve or merge PRs automatically.

## Pause, resume, cancel and retry

Use task-detail actions to pause/cancel queued work or request a process-group stop for active work. An active task remains `stopping` until its node acknowledges the stop; the UI does not pretend that sending a request has stopped a process. Resume preserves work and the approved plan. Explicit retries use a new quota-failover generation, so recovered connections can be tried again. A parent workflow can pause/cancel its children and waits for active children's stop acknowledgments.

## Multi-agent task dependencies

After a parent plan is ready, choose decomposition and edit 1–12 child tasks with their tool connections and dependency keys. The console rejects cyclic dependencies and unauthorized connections. Confirming the parent plan starts eligible root tasks; dependent children wait for prerequisite results. Each agent has an independent worktree. Downstream jobs receive prerequisite summaries, branches and PR references as context.

Dependency edges determine scheduling; they do **not** merge code. Make code integration an explicit child task and review its diff/tests. The parent remains awaiting human review when its children finish. Current workflow decomposition is human-editable; it is not an autonomous code-merging system.

## Cross-node checkpoints

Start both nodes with the updated worker. They report a public X25519 key on heartbeat; the private key is written as `checkpoint-keys.json` beside the protected node configuration with mode 0600. Keep this file on that node and back it up securely; do not upload it to the console or commit it to a repository. Deleting it prevents decryption of checkpoints already addressed to that node.

The target must be online, have a fresh key/heartbeat, and be authorized for the same project and selected tool. After the source process group stops, the worker exports current Git work using a temporary index/ref without changing its real HEAD/index. It encrypts the checkpoint for the target and uploads ciphertext only. Task, project, source attempt, transfer and target-node identities are cryptographically bound. The target checks its leased attempt, digest and recipient context before restoring into an isolated task worktree. Staged, unstaged and untracked source changes are retained; the user's main checkout is not overwritten.

The encrypted plaintext envelope is limited to 8 MiB (including bundle encoding/metadata). Bundles contain only changes after the mapped shared baseline, which the target clone must already possess. Sensitive-looking paths in current changes or source commit history, symlinks, submodules, missing baselines and unrelated existing target worktrees cause explicit rejection. The system does not bypass an offline source or discard a conflicting target worktree. Failed restore or incompatible existing state may require manual repair before retrying; source work and the encrypted checkpoint remain available.

Automatic quota failover remains same-node. Cross-node movement is an explicit user action, not an automatic transfer of code to another machine.

## Members, usage and budgets

Administrators can rename, disable and change roles for members, reset passwords and edit team membership. The last enabled administrator cannot be removed or demoted. Password resets invalidate existing sessions; changing your own password requires the current password. Removing a shared-team grant requests a stop for affected running tasks and waits for the node's stop acknowledgment.

Project owners and administrators can set daily run, input/output token and recorded USD cost limits from the project page. Days use UTC. Planning and execution each count as a run when claimed. Token counts and costs come from structured provider output; unsupported cost reporting stays unknown, not zero. This does not query your Codex or Cursor subscription balance. A cost limit without any reported cost blocks new claims. Limits stop subsequent claims; in-flight work can exceed token or cost limits before reporting its usage.

## Node restart recovery

Workers persist private attempt journals in `.gastown-node-journals/` beside the local configuration, outside task worktrees. Treat these files as credentials because they contain attempt leases; keep the directory private and out of Git. A process lock prevents two workers from starting against the same configuration. On restart, the worker checks the recorded supervisor's PID, start time, process group and unique marker before stopping owned work. Confirmed stopped work becomes paused and requires explicit resume. An uncertain process identity or incomplete transfer remains `recovery_required`; investigate on the node before continuing. Recovery never automatically launches another writer.

## Accept results or request changes

After an execution returns `awaiting_review`, inspect the result in your IDE and choose acceptance or request changes in the task detail. Acceptance records your decision and marks the task completed; it does not merge branches, commit files or push code. Requesting changes requires written feedback, queues a new execution with the existing approved plan and tool permissions, and retains the task worktree, including edits you made during review. The next tool invocation receives that feedback and returns a refreshed review report. Feedback never grants new push/PR permissions. Review decisions remain in task history.

For a decomposed workflow, review its children first; the parent can be accepted only after every child is accepted. Parent-level rework is not automatic. Reworking a child that already has dependent tasks is rejected instead of silently rerunning or invalidating downstream work; coordinate those changes explicitly. Independent or leaf children can be returned for corrections and make the parent await review again.

## Synchronize an existing node configuration

A node can serve multiple projects. Its owner can edit the existing node's name and sharing from the node list or detail view; editing preserves its ID, credentials and local pairing. Manage execution-node selections only on the project page. A private local project retains its paired local node. Removing a project's selected node or narrowing node sharing requests a safe stop for affected running work and cancels affected queued work; it does not transfer execution to another machine. Tool connections still have independent project grants for account usage: authorize the project on its tool connection as well, then synchronize the node's local repository mappings. Existing node-side associations migrate once into project selections when upgrading.

Copied node commands use the installation directory and configuration file path explicitly. Fill both absolute paths for the execution computer in the node setup or detail panel; these non-credential preferences are remembered separately for each account and node. The installation directory must be the `console/` folder containing `package.json`. The generated `npm --prefix` commands can run from any terminal directory, tighten configuration permissions to mode 0600, and prompt for a missing node token without echoing it. Pairing asks for its short-lived code separately. Do not point a real node at disposable smoke-test configuration files or service URLs.

After adding a local project, run this on the paired computer from `console/`:

```sh
npm run node -- --config "$PWD/node-config.json" --sync-config
```

The command fetches this node's authorized projects, validates local Git roots and branches, and adds local-project mappings automatically. For a new remote project, specify its local clone explicitly:

```sh
npm run node -- --config "$PWD/node-config.json" --sync-config --map '<project-id>=/absolute/path/to/clone'
```

Repeat `--map` for more projects. Existing tool paths, credentials, custom settings and unrelated mappings are preserved. Missing remote paths are reported, not guessed. A local-project mapping cannot be redirected to a different directory. Failed validation leaves the original JSON unchanged. Successful updates create a mode-0600 original copy inside adjacent `.gastown-node-config-backups/` and atomically replace the configuration; keep backups private and outside version control. Concurrent synchronization is refused, and a detected manual edit aborts the update. If a terminated command leaves a `.sync.lock` file, confirm no synchronization process is running before removing that stale lock. The command does not discover models, poll for tasks or invoke AI tools. Restart an already-running worker to load the new configuration. Initial node registration and tool login are still required.

## Verification

```sh
npm test
npm run test:coverage
npm run check
npm audit --omit=dev
```

Tests use temporary databases, temporary repositories and fixture tools. They do not spend model credits or push real repositories. The main Go CLI and existing daemon are outside this package's build/runtime.
