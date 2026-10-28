package config

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/steveyegge/gastown/internal/runtimefailover"
)

func activateTestFailover(t *testing.T, root string) {
	t.Helper()
	if err := SaveTownSettings(TownSettingsPath(root), &TownSettings{Type: "town-settings", Version: CurrentTownSettingsVersion, RuntimeFailover: &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtimefailover.SaveState(root, &runtimefailover.State{Source: "codex", Target: "cursor", ActivatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

func TestResolveAgentConfigFailoverRoutesDefault(t *testing.T) {
	root := t.TempDir()
	if err := SaveTownSettings(TownSettingsPath(root), &TownSettings{Type: "town-settings", Version: CurrentTownSettingsVersion, DefaultAgent: "codex", RuntimeFailover: &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtimefailover.SaveState(root, &runtimefailover.State{Source: "codex", Target: "cursor", ActivatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rc := ResolveAgentConfig(root, "")
	if rc.ResolvedAgent != "cursor" {
		t.Fatalf("ResolvedAgent=%q", rc.ResolvedAgent)
	}
}

func TestResolveAgentConfigWithOverrideFailoverDropsSourceArgs(t *testing.T) {
	root := t.TempDir()
	activateTestFailover(t, root)
	rc, agent, err := ResolveAgentConfigWithOverride(root, "", "codex --model original-model")
	if err != nil {
		t.Fatal(err)
	}
	if agent != "cursor" || rc.ResolvedAgent != "cursor" {
		t.Fatalf("agent=%q metadata=%q", agent, rc.ResolvedAgent)
	}
	if strings.Contains(strings.Join(rc.Args, " "), "original-model") {
		t.Fatalf("source override args leaked: %v", rc.Args)
	}
}

func TestRoleAndWorkerFailover(t *testing.T) {
	root := t.TempDir()
	rig := filepath.Join(root, "rig")
	if err := SaveTownSettings(TownSettingsPath(root), &TownSettings{Type: "town-settings", Version: CurrentTownSettingsVersion, RoleAgents: map[string]string{"crew": "codex"}, CrewAgents: map[string]string{"bob": "codex"}, RuntimeFailover: &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}}); err != nil {
		t.Fatal(err)
	}
	if err := runtimefailover.SaveState(root, &runtimefailover.State{Source: "codex", Target: "cursor", ActivatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	for name, rc := range map[string]*RuntimeConfig{"role": ResolveRoleAgentConfig("crew", root, rig), "worker": ResolveWorkerAgentConfig("bob", root, rig)} {
		if rc.ResolvedAgent != "cursor" {
			t.Errorf("%s resolved %q", name, rc.ResolvedAgent)
		}
	}
}

func TestBuildStartupCommandOverrideUsesRoutedAgentMetadata(t *testing.T) {
	root := t.TempDir()
	rig := filepath.Join(root, "rig")
	activateTestFailover(t, root)
	if err := SaveRigSettings(RigSettingsPath(rig), NewRigSettings()); err != nil {
		t.Fatal(err)
	}
	cmd, err := BuildStartupCommandWithAgentOverride(map[string]string{}, rig, "", "codex --model original-model")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"cursor-agent", "GT_AGENT=cursor", "GT_PROCESS_NAMES=cursor-agent,agent"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command missing %q: %s", want, cmd)
		}
	}
	for _, unwanted := range []string{"GT_AGENT=codex", "GT_PROCESS_NAMES=codex", "original-model", "dangerously-bypass-approvals"} {
		if strings.Contains(cmd, unwanted) {
			t.Errorf("command unexpectedly contains %q: %s", unwanted, cmd)
		}
	}
}
