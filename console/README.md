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

1. Create a project in the console, specifying the repository URL and base branch.
2. Register a node with its owner, visibility and permitted projects. Copy its token once; the server stores only its hash.
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

Use `read -s GAS_TOWN_NODE_TOKEN` in zsh; the `read -rs` example is for bash. The token can alternatively be entered into the protected local config as `token`, with the same file permissions.

Run these commands from the `console/` directory of this feature's checkout after `npm ci`. Preflight (`--check`) verifies the configured server, authorization, repositories, executable paths and model catalogs and sends a heartbeat; it never polls for or executes tasks. Starting without `--check` begins the worker loop. A registered node is waiting until its first heartbeat, online while heartbeats are fresh, and offline once they expire. If the one-time token is lost, revoke the old node and register a new one; the console cannot recover its plaintext token.

Use the actual base branch of the local repository. Login to each CLI on the execution machine beforehand; never upload provider login files to the control plane. Configure only tools you intend to use. The worker polls outbound, discovers capabilities and reports actual events. Local tool/config paths are not supplied by web task payloads.

One node uses one local OS identity and its tool logins. Only its owner creates connections on it; teammates use explicitly shared connections. To host members' separate private tool accounts on a shared server, run separate node processes under separate OS users/isolated homes and repository access. Sharing a server entry in the console does not create OS isolation or independent provider logins. Node protocol/HTTP authorization cannot substitute for this boundary.

## Task lifecycle and sharing

Connections and projects start private. Owners may separately share them with a team or explicit members. A user needs project, node and connection access; sharing a task alone grants no tool credentials. Configure a connection only after its node reports tool models. Models and reasoning modes are validated against the connection's catalog and owner restrictions. Attempts snapshot their configuration.

Creating a task queues a planning job. An execution node calls the selected CLI in planning mode. Review the returned plan and explicitly approve execution, commits/push and PR creation. No task receives merge authorization. Observe task events and errors in the task detail view.

Manual transfer checks target permissions and uses target model settings. For an active source, the task enters `stopping`; the node must terminate the original process group and acknowledge a worktree checkpoint before the target can be claimed. A missing stop acknowledgment does not permit a second writer. Transfers are restricted to connections on the same execution node. Cross-node checkpoint transport remains a separate milestone; unsupported operations return explicit errors.

Automatic same-node quota handoff is opt-in for each task and both source/target connections. It requires a structured tool quota error, a verified stopped process group, a worktree checkpoint and currently valid permissions. Each exhausted connection is excluded from automatic retries for that task, preventing a loop between exhausted accounts. When no eligible connection remains, the task stays blocked for human intervention. Ordinary network errors and quoted quota messages do not trigger a switch. PR-authorized jobs report success only after `gh pr view` verifies the PR belongs to the expected repository and task/base branches; install and authenticate GitHub CLI on nodes where PR delivery is enabled.

The worker creates a task Git worktree and preserves it for continuation. It does not reset or clean the user's checkout. Repository pushes and PR creation may incur external side effects only after task approval permits them. The console does not approve or merge PRs automatically.

## Verification

```sh
npm test
npm run test:coverage
npm run check
npm audit --omit=dev
```

Tests use temporary databases, temporary repositories and fixture tools. They do not spend model credits or push real repositories. The main Go CLI and existing daemon are outside this package's build/runtime.
