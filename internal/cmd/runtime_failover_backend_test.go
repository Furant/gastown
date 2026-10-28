package cmd

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/steveyegge/gastown/internal/config"
)

type fakeFailoverTmux struct {
	sessions   []string
	envs       map[string]map[string]string
	workdirs   map[string]string
	panes      map[string]string
	captures   map[string]string
	sets       map[string]map[string]string
	respawns   []fakeRespawn
	getErr     error
	setErr     error
	respawnErr error
}
type fakeRespawn struct{ pane, cwd, command string }

func newRecoveryFixture(t *testing.T, name, role string) (*runtimeFailoverBackend, *fakeFailoverTmux) {
	t.Helper()
	root := t.TempDir()
	work := filepath.Join(root, "work")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	writeRuntimeFailoverRig(t, root)
	cli := filepath.Join(root, "cursor-agent")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	settings := config.NewTownSettings()
	settings.Agents["cursor"] = &config.RuntimeConfig{Provider: "cursor", Command: cli, Args: []string{"fake-mode"}}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}
	f := &fakeFailoverTmux{sessions: []string{name}, envs: map[string]map[string]string{name: {"GT_ROOT": root, "GT_AGENT": "codex", "GT_ROLE": role, "GT_AGENT_READY": "1", "GT_SESSION_ID_ENV": "CODEX_THREAD_ID"}}, workdirs: map[string]string{name: work}, panes: map[string]string{name: "%9"}, sets: map[string]map[string]string{}}
	return &runtimeFailoverBackend{townRoot: root, tmux: f}, f
}

func TestRuntimeFailoverBackendPreservesFullRole(t *testing.T) {
	for _, tc := range []struct{ name, role string }{{"hq-mayor", "mayor"}, {"rg-crew-bob", "rig/crew/bob"}, {"rg-worker", "rig/polecats/worker"}} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := newRecoveryFixture(t, tc.name, tc.role)
			if err := b.Prepare(tc.name, "cursor"); err != nil {
				t.Fatal(err)
			}
			if got := b.plans[tc.name].env["GT_ROLE"]; got != tc.role {
				t.Fatalf("lost full identity: got %q want %q", got, tc.role)
			}
		})
	}
}

func TestRuntimeFailoverBackendClearsSourceReadiness(t *testing.T) {
	b, f := newRecoveryFixture(t, "hq-mayor", "mayor")
	if err := b.Prepare("hq-mayor", "cursor"); err != nil {
		t.Fatal(err)
	}
	if err := b.Recover("hq-mayor", "cursor"); err != nil {
		t.Fatal(err)
	}
	if f.envs["hq-mayor"]["GT_AGENT_READY"] != "" || f.envs["hq-mayor"]["GT_SESSION_ID_ENV"] == "CODEX_THREAD_ID" {
		t.Fatalf("source readiness metadata leaked: %+v", f.envs["hq-mayor"])
	}
}

func TestRuntimeFailoverBackendReportsRollbackFailure(t *testing.T) {
	b, f := newRecoveryFixture(t, "hq-mayor", "mayor")
	if err := b.Prepare("hq-mayor", "cursor"); err != nil {
		t.Fatal(err)
	}
	f.setErr = errors.New("metadata unavailable")
	if err := b.Recover("hq-mayor", "cursor"); err == nil || !strings.Contains(err.Error(), "rollback") {
		t.Fatalf("rollback failure hidden: %v", err)
	}
	if len(f.respawns) != 0 {
		t.Fatal("started target after metadata update failure")
	}
}

func (f *fakeFailoverTmux) ListSessions() ([]string, error) {
	return append([]string(nil), f.sessions...), nil
}
func (f *fakeFailoverTmux) GetEnvironment(s, k string) (string, error) {
	if f.getErr != nil {
		return "", f.getErr
	}
	v, ok := f.envs[s][k]
	if !ok {
		return "", errors.New("missing")
	}
	return v, nil
}
func (f *fakeFailoverTmux) GetPaneWorkDir(s string) (string, error) { return f.workdirs[s], nil }
func (f *fakeFailoverTmux) GetPaneID(s string) (string, error)      { return f.panes[s], nil }
func (f *fakeFailoverTmux) CapturePane(s string, n int) (string, error) {
	v := f.captures[s]
	lines := strings.Split(v, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n"), nil
}
func (f *fakeFailoverTmux) SetEnvironment(s, k, v string) error {
	if f.setErr != nil {
		return f.setErr
	}
	if f.sets[s] == nil {
		f.sets[s] = map[string]string{}
	}
	f.sets[s][k] = v
	if f.envs[s] == nil {
		f.envs[s] = map[string]string{}
	}
	f.envs[s][k] = v
	return nil
}
func (f *fakeFailoverTmux) RespawnPaneWithWorkDir(p, c, cmd string) error {
	f.respawns = append(f.respawns, fakeRespawn{p, c, cmd})
	return f.respawnErr
}

func TestRuntimeFailoverBackendSessionsTownAndAgent(t *testing.T) {
	root := t.TempDir()
	rigPath := filepath.Join(root, "rig")
	if err := os.MkdirAll(rigPath, 0700); err != nil {
		t.Fatal(err)
	}
	writeRuntimeFailoverRig(t, root)
	f := &fakeFailoverTmux{sessions: []string{"hq-mayor", "rg-crew-bob", "rg-worker"}, envs: map[string]map[string]string{
		"hq-mayor": {"GT_ROOT": root, "GT_AGENT": "codex"}, "rg-crew-bob": {"GT_ROOT": root, "GT_AGENT": "cursor"}, "rg-worker": {"GT_ROOT": "/other", "GT_AGENT": "codex"},
	}}
	b := &runtimeFailoverBackend{townRoot: root, tmux: f}
	got, err := b.Sessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Agent != "codex" || got[1].Agent != "cursor" {
		t.Fatalf("Sessions=%+v", got)
	}
	f.getErr = errors.New("environment unavailable")
	got, err = b.Sessions()
	if err != nil || len(got) != 0 {
		t.Fatalf("failed env must fail closed: %+v, %v", got, err)
	}
}

func writeRuntimeFailoverRig(t *testing.T, root string) {
	t.Helper()
	path := filepath.Join(root, "mayor", "rigs.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"rigs":{"rig":{"beads":{"prefix":"rg"}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeFailoverBackendCaptureLast40Lines(t *testing.T) {
	lines := make([]string, 45)
	for i := range lines {
		lines[i] = string(rune('a' + i%26))
	}
	f := &fakeFailoverTmux{captures: map[string]string{"s": strings.Join(lines, "\n")}}
	b := &runtimeFailoverBackend{tmux: f}
	got, err := b.Capture("s")
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.Split(got, "\n")) != 40 || got == strings.Join(lines, "\n") {
		t.Fatalf("Capture lines incorrect: %q", got)
	}
}

func TestRuntimeFailoverBackendPrepareRejectsOutsideTownWithoutMutation(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	f := &fakeFailoverTmux{workdirs: map[string]string{"hq-mayor": outside}, panes: map[string]string{"hq-mayor": "%1"}, envs: map[string]map[string]string{"hq-mayor": {"GT_ROOT": root, "GT_AGENT": "codex", "GT_ROLE": "mayor"}}}
	b := &runtimeFailoverBackend{townRoot: root, tmux: f}
	if err := b.Prepare("hq-mayor", "cursor"); err == nil {
		t.Fatal("expected out-of-town cwd error")
	}
	if len(f.sets) != 0 || len(f.respawns) != 0 {
		t.Fatalf("preflight caused side effects: sets=%v respawns=%v", f.sets, f.respawns)
	}
}

func TestRuntimeFailoverBackendPrepareReturnsUnknownTargetAndMissingBinary(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "mayor")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), config.NewTownSettings()); err != nil {
		t.Fatal(err)
	}
	f := &fakeFailoverTmux{workdirs: map[string]string{"hq-mayor": work}, panes: map[string]string{"hq-mayor": "%1"}, envs: map[string]map[string]string{"hq-mayor": {"GT_ROOT": root, "GT_AGENT": "codex", "GT_ROLE": "mayor"}}, sets: map[string]map[string]string{}}
	b := &runtimeFailoverBackend{townRoot: root, tmux: f}
	if err := b.Prepare("hq-mayor", "not-an-agent"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unknown target error=%v", err)
	}
	t.Setenv("PATH", t.TempDir())
	err := b.Prepare("hq-mayor", "cursor")
	if err == nil || !strings.Contains(err.Error(), "executable") {
		t.Fatalf("missing binary error=%v", err)
	}
	if len(f.sets) != 0 || len(f.respawns) != 0 {
		t.Fatalf("failed preflight caused mutations: %+v", f)
	}
}

func TestRuntimeFailoverBackendRecoverPreservesWorkdirAndWritesHandoff(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "mayor")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	cli := filepath.Join(bin, "cursor-agent")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := config.SaveTownSettings(config.TownSettingsPath(root), config.NewTownSettings()); err != nil {
		t.Fatal(err)
	}
	f := &fakeFailoverTmux{sessions: []string{"hq-mayor"}, envs: map[string]map[string]string{"hq-mayor": {"GT_ROOT": root, "GT_AGENT": "codex", "GT_ROLE": "mayor", "CODEX_THREAD_ID": "old-thread", "CLAUDE_SESSION_ID": "old-session"}}, workdirs: map[string]string{"hq-mayor": work}, panes: map[string]string{"hq-mayor": "%9"}, sets: map[string]map[string]string{}}
	b := &runtimeFailoverBackend{townRoot: root, tmux: f}
	if err := b.Prepare("hq-mayor", "cursor"); err != nil {
		t.Fatal(err)
	}
	if len(f.sets) != 0 || len(f.respawns) != 0 {
		t.Fatal("Prepare must be read-only")
	}
	git, gitErr := exec.LookPath("git")
	if gitErr == nil {
		if out, err := exec.Command(git, "init", "-b", "preserve-me", work).CombinedOutput(); err != nil {
			t.Fatalf("git init: %s: %v", out, err)
		}
	}
	if err := b.Recover("hq-mayor", "cursor"); err != nil {
		t.Fatal(err)
	}
	if len(f.respawns) != 1 || f.respawns[0].cwd != work || f.respawns[0].pane != "%9" {
		t.Fatalf("respawns=%+v", f.respawns)
	}
	cmd := f.respawns[0].command
	for _, want := range []string{"cursor-agent", "GT_AGENT=cursor", "GT_PROCESS_NAMES=cursor-agent,agent", "runtime-failover-handoff.json", "gt prime"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command missing %q: %s", want, cmd)
		}
	}
	for _, bad := range []string{"CODEX_THREAD_ID=old-thread", "CLAUDE_SESSION_ID=old-session", "codex resume"} {
		if strings.Contains(cmd, bad) {
			t.Errorf("command leaked %q: %s", bad, cmd)
		}
	}
	if f.sets["hq-mayor"]["GT_AGENT"] != "cursor" || f.sets["hq-mayor"]["CODEX_THREAD_ID"] != "" {
		t.Fatalf("metadata=%v", f.sets["hq-mayor"])
	}
	data, err := os.ReadFile(filepath.Join(work, ".runtime", "runtime-failover-handoff.json"))
	if err != nil {
		t.Fatal(err)
	}
	var handoff runtimeFailoverHandoff
	if err := json.Unmarshal(data, &handoff); err != nil {
		t.Fatal(err)
	}
	if handoff.Source != "codex" || handoff.Target != "cursor" || handoff.Session != "hq-mayor" || handoff.WorkDir != work {
		t.Fatalf("handoff=%+v", handoff)
	}
	info, err := os.Stat(filepath.Join(work, ".runtime", "runtime-failover-handoff.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("handoff mode=%o", info.Mode().Perm())
	}
	if gitErr == nil {
		out, err := exec.Command(git, "-C", work, "branch", "--show-current").Output()
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(out)) != "preserve-me" {
			t.Fatalf("working branch changed: %s", out)
		}
	}
}
