package config

import (
	"testing"
	"time"

	"github.com/steveyegge/gastown/internal/runtimefailover"
)

func TestBuildStartupCommandFailoverFailsClosed(t *testing.T) {
	root := t.TempDir()
	policy := &runtimefailover.Config{Enabled: true, Source: "codex", Target: "missing-target-alias"}
	settings := NewTownSettings()
	settings.DefaultAgent = "codex"
	settings.RuntimeFailover = policy
	if err := SaveTownSettings(TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}
	if err := runtimefailover.SaveState(root, &runtimefailover.State{Source: policy.Source, Target: policy.Target, ActivatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if command, err := BuildStartupCommandWithAgentOverride(map[string]string{"GT_ROOT": root, "GT_ROLE": "mayor"}, "", "", ""); err == nil {
		t.Fatalf("launched exhausted source instead of reporting unavailable target: %s", command)
	}
}
