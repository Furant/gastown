# Runtime quota failover

## Goal and scope

Opt-in, one-way failover from the configured Codex agent alias to a Cursor agent alias after an explicit Codex usage-limit error. The daemon performs detection without an LLM. Unconfigured towns retain their existing runtime behavior and Claude account rotation is unchanged.

## Design

The town settings contain `runtime_failover` with `enabled`, `source`, and `target`. A private, atomically written `.runtime/runtime-failover.json` records activation. Runtime resolution applies that marker after existing agent precedence, including queued jobs and explicit source overrides. Target command, arguments, and process metadata come from the target configuration; source model flags and native resume IDs are not reused. Launch boundaries reject invalid active routing rather than silently starting the exhausted source. Full role identity is preserved and source readiness metadata is cleared.

Every 30 seconds the daemon calls `gt quota failover --json` when the policy is enabled. The CLI holds a town-wide filesystem lock throughout scanning and recovery, shared with configuration and clear operations. It only inspects recognized sessions belonging to this town. A generic HTTP 429, network error, or a quoted documentation example does not activate failover.

On a confirmed source quota error, recovery validates the target binary and existing work directory before changing the pane. It persists routing before replacement. Recovery writes a portable handoff in the same work directory, preserves the branch, uncommitted files, logical Gas Town identity and hooked task, then launches a new native target session. Only explicitly blocked sessions are replaced; healthy source sessions may finish. Successful replacement updates effective runtime metadata so repeated scans do not restart target sessions.

A failed preflight leaves the source session and routing untouched. Individual recovery errors are reported and retried on later scans, up to three failures per logical session. Failure counts survive daemon restarts; after repairing the target, clear the latch to retry. The global routing latch remains active when an old pane cannot be recovered, so future jobs are not sent back to an exhausted source. There is no automatic reverse switch or secondary fallback chain. Both providers being unavailable requires human intervention. `clear` removes the routing latch; it does not kill sessions or discard work.

## Implementation plan and ownership

1. `internal/runtimefailover/runtime_failover.go` and tests: policy validation, conservative detection, private atomic state, one-way routing.
2. `internal/config/types.go`, `loader.go`, and `runtime_failover.go`: optional policy and central effective-runtime resolution, with explicit/default/role/worker regression tests.
3. `internal/runtimefailover/recovery.go` and tests: backend-injected scan/recovery controller, durable activation, idempotency, dry-run and failure behavior.
4. `internal/cmd/runtime_failover.go` and tests: configure/status/clear/cycle CLI and shared lock. `runtime_failover_backend.go` and tests: tmux preflight, same-worktree handoff and replacement.
5. `internal/session/lifecycle.go`: launch metadata must reflect the effective target alias after redirection.
6. `internal/daemon/runtime_failover.go` and daemon loop: bounded subprocess polling independent of Claude quota rotation and model availability.

## Verification

Tests use temporary towns and fake tmux backends. CLI tests must not access live sessions. Exercise the controller end to end with isolated tmux and shell stand-ins for the provider CLIs; assert the same directory, original Git branch and uncommitted changes survive, the target starts once, and dry-run never mutates state or processes. Test configuration and failure paths before implementation. Run targeted Go tests, race checks, coverage, vet/build and a final code/security review. Never trigger real quota exhaustion or replace the user's running Gas Town installation to test this change.

## Operations

After building and installing the updated `gt`, configure from a town root:

```bash
gt quota failover configure --source codex --target cursor
gt quota failover --dry-run --json
gt quota failover status
```

The updated daemon must be running for automatic scans. Run a single cycle with `gt quota failover --json`. Clear a recovered source's routing latch using `gt quota failover clear`; existing target sessions continue. Disable monitoring with `gt quota failover configure --enabled=false`.

The target CLI must be installed and authenticated. Recovery cannot transfer a provider's full private conversation; it relies on the handoff, worktree, task ledger and `gt prime`.
