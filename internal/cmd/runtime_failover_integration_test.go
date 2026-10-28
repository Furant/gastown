package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/steveyegge/gastown/internal/config"
	"github.com/steveyegge/gastown/internal/runtimefailover"
	"github.com/steveyegge/gastown/internal/tmux"
)

func TestRuntimeFailoverIntegration(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux unavailable")
	}
	socket := "gt-quota-failover-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	tmx := tmux.NewTmuxWithSocket(socket)
	t.Cleanup(func() {
		// Kill only this test's isolated server; never inspect or clean another socket.
		_ = exec.Command(tmuxPath, "-L", socket, "kill-server").Run()
	})

	root := t.TempDir()
	work := filepath.Join(root, "mayor")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	work, err = filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "mayor", "rigs.json"), []byte(`{"rigs":{}}`), 0600); err != nil {
		t.Fatal(err)
	}

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git unavailable")
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(gitPath, args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Failover Test", "GIT_AUTHOR_EMAIL=failover@example.invalid", "GIT_COMMITTER_NAME=Failover Test", "GIT_COMMITTER_EMAIL=failover@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-b", "failover-preserve")
	baseline := filepath.Join(work, "baseline.txt")
	if err := os.WriteFile(baseline, []byte("committed baseline\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", "baseline.txt")
	git("commit", "-m", "baseline")
	branchBefore := git("branch", "--show-current")
	if err := os.WriteFile(baseline, []byte("uncommitted user work\n"), 0600); err != nil {
		t.Fatal(err)
	}

	markers := t.TempDir()
	codexScript := filepath.Join(markers, "fake-codex")
	cursorScript := filepath.Join(markers, "fake-cursor")
	targetStarts := filepath.Join(markers, "target-starts")
	targetCWD := filepath.Join(markers, "target-cwd")
	if err := os.WriteFile(codexScript, []byte("#!/bin/sh\nprintf \"You've hit your usage limit.\\n\"\nexec sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	cursorBody := fmt.Sprintf("#!/bin/sh\nprintf 'start\\n' >> %q\npwd > %q\nexec sleep 60\n", targetStarts, targetCWD)
	if err := os.WriteFile(cursorScript, []byte(cursorBody), 0700); err != nil {
		t.Fatal(err)
	}

	settings := config.NewTownSettings()
	settings.DefaultAgent = "codex"
	settings.RuntimeFailover = &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}
	settings.Agents["codex"] = &config.RuntimeConfig{Provider: "codex", Command: codexScript, Args: []string{}}
	settings.Agents["cursor"] = &config.RuntimeConfig{Provider: "generic", Command: cursorScript, Args: []string{}}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}

	// Avoid Tmux.NewSessionWithCommandAndEnv here: its split-brain protection
	// intentionally checks the default socket. Construct the fixture directly
	// through tmux -L so every tmux command stays on the unique test server.
	runTmux := func(args ...string) string {
		t.Helper()
		full := append([]string{"-L", socket}, args...)
		out, err := exec.Command(tmuxPath, full...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %s: %v", full, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	runTmux("new-session", "-d", "-s", "hq-mayor", "-c", work,
		"-e", "GT_ROOT="+root, "-e", "GT_ROLE=mayor", "-e", "GT_AGENT=codex", codexScript)
	runTmux("set-option", "-t", "hq-mayor", "remain-on-exit", "on")
	paneBefore, err := tmx.GetPaneID("hq-mayor")
	if err != nil {
		t.Fatalf("pane before: %v", err)
	}
	cwdBefore, err := tmx.GetPaneWorkDir("hq-mayor")
	if err != nil {
		t.Fatalf("cwd before: %v", err)
	}
	if cwdBefore != work {
		t.Fatalf("initial pane cwd=%q want %q", cwdBefore, work)
	}
	waitForFailoverOutput(t, tmx, "hq-mayor", "You've hit your usage limit.")

	backend := &runtimeFailoverBackend{townRoot: root, tmux: tmx}
	controller := runtimefailover.Controller{TownRoot: root, Policy: settings.RuntimeFailover, Backend: backend}
	dry, err := controller.Run(true)
	if err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	if len(dry.Results) != 1 || dry.Results[0].Status != "would_recover" {
		t.Fatalf("dry-run report=%+v", dry)
	}
	if _, err := os.Stat(targetStarts); !os.IsNotExist(err) {
		t.Fatalf("dry-run started target (stat err=%v)", err)
	}
	if state, err := runtimefailover.LoadState(root); err != nil || state != nil {
		t.Fatalf("dry-run changed latch: state=%+v err=%v", state, err)
	}

	report, err := controller.Run(false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(report.Results) != 1 || report.Results[0].Status != "recovered" || !report.Active {
		t.Fatalf("run report=%+v", report)
	}
	waitForFileContent(t, targetStarts, "start\n")
	waitForFileContent(t, targetCWD, work+"\n")
	paneAfter, err := tmx.GetPaneID("hq-mayor")
	if err != nil {
		t.Fatalf("pane after: %v", err)
	}
	cwdAfter, err := tmx.GetPaneWorkDir("hq-mayor")
	if err != nil {
		t.Fatalf("cwd after: %v", err)
	}
	if paneAfter != paneBefore || cwdAfter != cwdBefore {
		t.Fatalf("pane/workdir changed: before=(%s,%s) after=(%s,%s)", paneBefore, cwdBefore, paneAfter, cwdAfter)
	}
	if got, err := tmx.GetEnvironment("hq-mayor", "GT_AGENT"); err != nil || got != "cursor" {
		t.Fatalf("GT_AGENT=%q err=%v", got, err)
	}
	if got := git("branch", "--show-current"); got != branchBefore {
		t.Fatalf("branch changed: before=%q after=%q", branchBefore, got)
	}
	if got, err := os.ReadFile(baseline); err != nil || string(got) != "uncommitted user work\n" {
		t.Fatalf("working file changed: content=%q err=%v", got, err)
	}
	handoff := filepath.Join(work, ".runtime", "runtime-failover-handoff.json")
	info, err := os.Stat(handoff)
	if err != nil {
		t.Fatalf("handoff: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("handoff mode=%#o want 0600", info.Mode().Perm())
	}
	state, err := runtimefailover.LoadState(root)
	if err != nil || state == nil || state.Source != "codex" || state.Target != "cursor" {
		t.Fatalf("active state=%+v err=%v", state, err)
	}

	again, err := controller.Run(false)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if len(again.Results) != 0 {
		t.Fatalf("second run unexpectedly recovered again: %+v", again)
	}
	starts, err := os.ReadFile(targetStarts)
	if err != nil || string(starts) != "start\n" {
		t.Fatalf("target starts=%q err=%v; want exactly one", starts, err)
	}

	routed, agent, err := config.ResolveAgentConfigWithOverride(root, "", "codex")
	if err != nil {
		t.Fatalf("explicit codex resolution: %v", err)
	}
	if agent != "cursor" || routed.ResolvedAgent != "cursor" || routed.Command != cursorScript {
		t.Fatalf("explicit codex routed to agent=%q config=%+v", agent, routed)
	}
}

func waitForFailoverOutput(t *testing.T, tmx *tmux.Tmux, session, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got, err := tmx.CapturePane(session, 40); err == nil && strings.Contains(got, want) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	got, _ := tmx.CapturePane(session, 40)
	t.Fatalf("timed out waiting for source output %q; pane=%q", want, got)
}

func waitForFileContent(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got, err := os.ReadFile(path); err == nil && string(got) == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	got, err := os.ReadFile(path)
	t.Fatalf("timed out waiting for %s=%q; got=%q err=%v", path, want, got, err)
}
