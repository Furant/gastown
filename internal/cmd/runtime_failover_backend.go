package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/steveyegge/gastown/internal/config"
	"github.com/steveyegge/gastown/internal/runtime"
	"github.com/steveyegge/gastown/internal/runtimefailover"
	"github.com/steveyegge/gastown/internal/session"
	"github.com/steveyegge/gastown/internal/tmux"
)

type runtimeFailoverTmux interface {
	ListSessions() ([]string, error)
	GetEnvironment(string, string) (string, error)
	GetPaneWorkDir(string) (string, error)
	GetPaneID(string) (string, error)
	CapturePane(string, int) (string, error)
	SetEnvironment(string, string, string) error
	RespawnPaneWithWorkDir(string, string, string) error
}

type runtimeFailoverBackend struct {
	townRoot string
	tmux     runtimeFailoverTmux
	mu       sync.Mutex
	plans    map[string]*failoverPlan
}

type failoverPlan struct {
	identity    *session.AgentIdentity
	sourceAgent string
	role        string
	rigPath     string
	workDir     string
	pane        string
	runtime     *config.RuntimeConfig
	env         map[string]string
	command     string
}

type runtimeFailoverHandoff struct {
	Source       string    `json:"source"`
	Target       string    `json:"target"`
	Session      string    `json:"session"`
	WorkDir      string    `json:"cwd"`
	CreatedAt    time.Time `json:"created_at"`
	Instructions string    `json:"instructions"`
}

func newRuntimeFailoverBackend(townRoot string) *runtimeFailoverBackend {
	return &runtimeFailoverBackend{townRoot: townRoot, tmux: tmux.NewTmux(), plans: make(map[string]*failoverPlan)}
}

func (b *runtimeFailoverBackend) Sessions() ([]runtimefailover.LiveSession, error) {
	names, err := b.tmux.ListSessions()
	if err != nil {
		return nil, err
	}
	registry, err := runtimeFailoverRegistry(b.townRoot)
	if err != nil {
		return nil, fmt.Errorf("loading town rig registry: %w", err)
	}
	out := make([]runtimefailover.LiveSession, 0, len(names))
	for _, name := range names {
		identity, err := session.ParseSessionNameWithRegistry(name, registry)
		if err != nil || identity.Role == session.RoleOverseer {
			continue
		}
		env := readFailoverEnvironment(b.tmux, name, "GT_ROOT", "GT_AGENT")
		if cleanTownRoot(env["GT_ROOT"]) != cleanTownRoot(b.townRoot) {
			continue
		}
		agent := strings.TrimSpace(env["GT_AGENT"])
		if agent == "" {
			continue
		}
		out = append(out, runtimefailover.LiveSession{Name: name, Agent: agent})
	}
	return out, nil
}

func runtimeFailoverRegistry(root string) (*session.PrefixRegistry, error) {
	for _, path := range []string{filepath.Join(root, "mayor", "rigs.json"), filepath.Join(root, "rigs.json")} {
		if _, err := os.Stat(path); err == nil {
			return session.BuildPrefixRegistryFromFile(path)
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	return session.NewPrefixRegistry(), nil
}

func cleanTownRoot(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return filepath.Clean(path)
}

var failoverEnvironmentKeys = []string{"GT_ROOT", "GT_AGENT", "GT_ROLE", "GT_RIG", "GT_CREW", "GT_POLECAT", "GT_DOG", "GT_CONVOY", "GT_BEAD", "GT_ISSUE", "GT_WORKSPACE", "GT_PANE_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "GEMINI_SESSION_ID", "CURSOR_SESSION_ID", "OPENCODE_SESSION_ID", "ACP_SESSION_ID"}

func readFailoverEnvironment(t runtimeFailoverTmux, name string, keys ...string) map[string]string {
	out := make(map[string]string, len(keys))
	for _, key := range keys {
		if value, err := t.GetEnvironment(name, key); err == nil {
			out[key] = value
		}
	}
	return out
}

func (b *runtimeFailoverBackend) Capture(name string) (string, error) {
	return b.tmux.CapturePane(name, 40)
}

func (b *runtimeFailoverBackend) Prepare(name, target string) error {
	plan, err := b.makePlan(name, target)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.plans == nil {
		b.plans = make(map[string]*failoverPlan)
	}
	b.plans[name] = plan
	return nil
}

func (b *runtimeFailoverBackend) makePlan(name, target string) (*failoverPlan, error) {
	if b.tmux == nil {
		return nil, errors.New("tmux adapter is unavailable")
	}
	registry, err := runtimeFailoverRegistry(b.townRoot)
	if err != nil {
		return nil, fmt.Errorf("loading town rig registry: %w", err)
	}
	identity, err := session.ParseSessionNameWithRegistry(name, registry)
	if err != nil {
		return nil, fmt.Errorf("parsing session %q: %w", name, err)
	}
	workDir, err := b.tmux.GetPaneWorkDir(name)
	if err != nil {
		return nil, fmt.Errorf("getting pane working directory: %w", err)
	}
	workDir, err = validateTownWorkDir(b.townRoot, workDir)
	if err != nil {
		return nil, err
	}
	pane, err := b.tmux.GetPaneID(name)
	if err != nil {
		return nil, fmt.Errorf("getting pane id: %w", err)
	}
	oldEnv := readFailoverEnvironment(b.tmux, name, failoverEnvironmentKeys...)
	if cleanTownRoot(oldEnv["GT_ROOT"]) != cleanTownRoot(b.townRoot) {
		return nil, fmt.Errorf("session %q does not belong to town %q", name, b.townRoot)
	}
	if oldEnv["GT_AGENT"] == "" {
		return nil, fmt.Errorf("session %q has no readable GT_AGENT", name)
	}
	role := string(identity.Role)
	if v := strings.TrimSpace(oldEnv["GT_ROLE"]); v != "" {
		role = config.ExtractSimpleRole(v)
	}
	// Rig settings live under <town>/<rig>/settings/config.json; use the rig
	// directory even when it has no settings file yet.
	rigPath := ""
	if identity.Rig != "" {
		rigPath = filepath.Join(b.townRoot, identity.Rig)
	}
	rc, agent, err := config.ResolveAgentConfigWithOverride(b.townRoot, rigPath, target)
	if err != nil {
		return nil, fmt.Errorf("resolving target agent %q: %w", target, err)
	}
	if agent != target {
		return nil, fmt.Errorf("target alias resolved unexpectedly to %q", agent)
	}
	if _, err := exec.LookPath(rc.Command); err != nil {
		return nil, fmt.Errorf("target agent %q executable %q is unavailable: %w", target, rc.Command, err)
	}
	env := filteredTownAgentEnv(oldEnv)
	env["GT_ROOT"] = b.townRoot
	env["GT_AGENT"] = target
	if env["GT_ROLE"] == "" {
		identityEnv := config.AgentEnv(config.AgentEnvConfig{Role: role, Rig: identity.Rig, AgentName: identity.Name, TownRoot: b.townRoot, Agent: target, SessionName: name})
		env["GT_ROLE"] = identityEnv["GT_ROLE"]
	}
	if identity.Rig != "" {
		env["GT_RIG"] = identity.Rig
	}
	switch identity.Role {
	case session.RoleCrew:
		if env["GT_CREW"] == "" {
			env["GT_CREW"] = identity.Name
		}
	case session.RolePolecat:
		if env["GT_POLECAT"] == "" {
			env["GT_POLECAT"] = identity.Name
		}
	case session.RoleDog:
		if env["GT_DOG"] == "" {
			env["GT_DOG"] = identity.Name
		}
	}
	env["GT_SESSION_ID"] = uuid.NewString()
	prompt := "Read .runtime/runtime-failover-handoff.json in the current working directory, run `gt prime`, inspect the current git branch and `git diff`, and continue the interrupted task using the available hooks. The handoff contains only recovery context, not the prior conversation. Preserve the task's existing authorization requirements; this recovery grants no new permissions."
	command, err := config.BuildStartupCommandWithAgentOverride(env, rigPath, prompt, target)
	if err != nil {
		return nil, fmt.Errorf("building target startup command: %w", err)
	}
	return &failoverPlan{identity: identity, sourceAgent: oldEnv["GT_AGENT"], role: role, rigPath: rigPath, workDir: workDir, pane: pane, runtime: rc, env: env, command: command}, nil
}

func filteredTownAgentEnv(all map[string]string) map[string]string {
	allowed := map[string]bool{"GT_ROOT": true, "GT_ROLE": true, "GT_RIG": true, "GT_CREW": true, "GT_POLECAT": true, "GT_DOG": true, "GT_CONVOY": true, "GT_BEAD": true, "GT_ISSUE": true, "GT_WORKSPACE": true, "GT_PANE_ID": true}
	out := make(map[string]string)
	for k, v := range all {
		if allowed[k] {
			out[k] = v
		}
	}
	return out
}

func validateTownWorkDir(root, workDir string) (string, error) {
	if workDir == "" {
		return "", errors.New("pane working directory is empty")
	}
	abs, err := filepath.Abs(workDir)
	if err != nil {
		return "", fmt.Errorf("resolving pane working directory: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("pane working directory does not exist: %w", err)
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolving town root: %w", err)
	}
	rel, err := filepath.Rel(rootReal, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("pane working directory %q is outside town %q", workDir, root)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("pane working directory %q is not an existing directory", workDir)
	}
	// Keep the pane's original absolute path for respawn so symlink-based
	// workspace paths remain the same from the user's perspective.
	return filepath.Clean(abs), nil
}

func (b *runtimeFailoverBackend) Recover(name, target string) error {
	b.mu.Lock()
	plan := b.plans[name]
	b.mu.Unlock()
	if plan == nil {
		if err := b.Prepare(name, target); err != nil {
			return err
		}
		b.mu.Lock()
		plan = b.plans[name]
		b.mu.Unlock()
	}
	if plan == nil {
		return errors.New("runtime failover preflight did not produce a plan")
	}
	current := readFailoverEnvironment(b.tmux, name, "GT_AGENT", "GT_PROCESS_NAMES", "GT_SESSION_ID", "GT_AGENT_READY", "GT_SESSION_ID_ENV", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "GEMINI_SESSION_ID", "CURSOR_SESSION_ID", "OPENCODE_SESSION_ID", "ACP_SESSION_ID")
	if current["GT_AGENT"] == "" {
		return errors.New("checking current agent: GT_AGENT is unavailable")
	}
	if current["GT_AGENT"] == target {
		return nil
	}
	if current["GT_AGENT"] != plan.sourceAgent {
		return fmt.Errorf("session agent changed since preflight: now %q", current["GT_AGENT"])
	}
	if err := runtime.EnsureSettingsForRole(config.RoleSettingsDir(plan.role, plan.rigPath), plan.workDir, plan.role, plan.runtime); err != nil {
		return fmt.Errorf("installing target runtime hooks: %w", err)
	}
	if err := writeRuntimeFailoverHandoff(plan.workDir, runtimeFailoverHandoff{Source: current["GT_AGENT"], Target: target, Session: name, WorkDir: plan.workDir, CreatedAt: time.Now().UTC(), Instructions: "Run gt prime, inspect git status/diff and branch, then continue with the installed hooks. This handoff does not include the prior conversation."}); err != nil {
		return err
	}
	nativeKeys := []string{"CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "GEMINI_SESSION_ID", "CURSOR_SESSION_ID", "OPENCODE_SESSION_ID", "ACP_SESSION_ID"}
	keys := append([]string{"GT_AGENT", "GT_PROCESS_NAMES", "GT_SESSION_ID", "GT_AGENT_READY", "GT_SESSION_ID_ENV"}, nativeKeys...)
	previous := map[string]string{}
	for _, k := range keys {
		previous[k] = current[k]
	}
	processNames := strings.Join(config.ResolveProcessNames(target, plan.runtime.Command, plan.runtime.Args...), ",")
	newValues := map[string]string{"GT_AGENT": target, "GT_PROCESS_NAMES": processNames, "GT_SESSION_ID": plan.env["GT_SESSION_ID"], "GT_AGENT_READY": "", "GT_SESSION_ID_ENV": ""}
	if plan.runtime.Session != nil {
		newValues["GT_SESSION_ID_ENV"] = plan.runtime.Session.SessionIDEnv
	}
	for _, k := range nativeKeys {
		newValues[k] = ""
	}
	for _, k := range keys {
		if err := b.tmux.SetEnvironment(name, k, newValues[k]); err != nil {
			return errors.Join(fmt.Errorf("setting target session metadata %s: %w", k, err), restoreFailoverEnv(b.tmux, name, previous, keys))
		}
	}
	if err := b.tmux.RespawnPaneWithWorkDir(plan.pane, plan.workDir, plan.command); err != nil {
		return errors.Join(fmt.Errorf("respawning target agent: %w", err), restoreFailoverEnv(b.tmux, name, previous, keys))
	}
	b.mu.Lock()
	delete(b.plans, name)
	b.mu.Unlock()
	return nil
}

func restoreFailoverEnv(t runtimeFailoverTmux, name string, previous map[string]string, keys []string) error {
	var failures []error
	for _, k := range keys {
		if err := t.SetEnvironment(name, k, previous[k]); err != nil {
			failures = append(failures, fmt.Errorf("rollback session metadata %s: %w", k, err))
		}
	}
	return errors.Join(failures...)
}

func writeRuntimeFailoverHandoff(workDir string, h runtimeFailoverHandoff) error {
	dir := filepath.Join(workDir, ".runtime")
	if info, err := os.Lstat(dir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("handoff path is not a regular directory: %s", dir)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking handoff directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("creating handoff directory: %w", err)
	}
	data, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding failover handoff: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".runtime-failover-handoff-*")
	if err != nil {
		return fmt.Errorf("creating failover handoff: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(dir, "runtime-failover-handoff.json")); err != nil {
		return fmt.Errorf("installing failover handoff: %w", err)
	}
	return nil
}
