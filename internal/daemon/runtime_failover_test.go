package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/steveyegge/gastown/internal/config"
	"github.com/steveyegge/gastown/internal/runtimefailover"
)

func TestRuntimeFailoverCycleDisabledDoesNotRunCommand(t *testing.T) {
	if out, err := runRuntimeFailoverCycle(context.Background(), t.TempDir(), "/does/not/exist"); err != nil || out != "" {
		t.Fatalf("disabled: %q %v", out, err)
	}
}

func TestRuntimeFailoverCycleUsesMechanicalCLI(t *testing.T) {
	root := t.TempDir()
	settings := config.NewTownSettings()
	settings.RuntimeFailover = &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "args")
	t.Setenv("FAILOVER_TEST_ARGS", marker)
	gt := filepath.Join(root, "fake-gt")
	if err := os.WriteFile(gt, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAILOVER_TEST_ARGS\"\nprintf '{\"results\":[]}\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := runRuntimeFailoverCycle(context.Background(), root, gt); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if string(args) != "quota\nfailover\n--json\n" {
		t.Fatalf("unexpected command arguments %q", args)
	}
}

func TestRuntimeFailoverCycleReportsFailure(t *testing.T) {
	root := t.TempDir()
	settings := config.NewTownSettings()
	settings.RuntimeFailover = &runtimefailover.Config{Enabled: true, Source: "codex", Target: "cursor"}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}
	gt := filepath.Join(root, "fake-gt")
	if err := os.WriteFile(gt, []byte("#!/bin/sh\necho 'target missing' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := runRuntimeFailoverCycle(context.Background(), root, gt); err == nil || !strings.Contains(err.Error(), "target missing") {
		t.Fatalf("missing failure detail: %v", err)
	}
}
