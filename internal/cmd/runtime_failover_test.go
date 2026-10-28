package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofrs/flock"
	"github.com/steveyegge/gastown/internal/config"
	"github.com/steveyegge/gastown/internal/runtimefailover"
)

func executeFailover(t *testing.T, root string, args ...string) (string, error) {
	t.Helper()
	c := newRuntimeFailoverCommandWith(func() (string, error) { return root, nil }, func(string) runtimefailover.Backend { t.Fatal("unexpected live session access"); return nil })
	var output bytes.Buffer
	c.SetOut(&output)
	c.SetErr(&output)
	c.SetArgs(args)
	err := c.Execute()
	return output.String(), err
}

func TestRuntimeFailoverConfigurePreservesSettings(t *testing.T) {
	root := t.TempDir()
	settings := config.NewTownSettings()
	settings.DefaultAgent = "codex"
	settings.RoleAgents = map[string]string{"mayor": "codex"}
	if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
		t.Fatal(err)
	}
	if _, err := executeFailover(t, root, "configure", "--source", "codex", "--target", "cursor"); err != nil {
		t.Fatal(err)
	}
	got, err := config.LoadOrCreateTownSettings(config.TownSettingsPath(root))
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultAgent != "codex" || got.RoleAgents["mayor"] != "codex" || got.RuntimeFailover == nil || !got.RuntimeFailover.Enabled {
		t.Fatalf("unexpected config: %+v", got)
	}
	if state, _ := runtimefailover.LoadState(root); state != nil {
		t.Fatal("configure activated failover before detection")
	}
}

func TestRuntimeFailoverRejectsUnsafePolicy(t *testing.T) {
	for _, target := range []string{"codex", "cursor; touch /tmp/unwanted", ""} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			if _, err := executeFailover(t, root, "configure", "--target", target); err == nil {
				t.Fatal("accepted unsafe configuration")
			}
		})
	}
}

func TestRuntimeFailoverDisabledCycleDoesNotInspectSessions(t *testing.T) {
	root := t.TempDir()
	output, err := executeFailover(t, root, "--json")
	if err != nil {
		t.Fatal(err)
	}
	var report runtimefailover.Report
	if err := json.Unmarshal([]byte(output), &report); err != nil {
		t.Fatal(err)
	}
	if report.Enabled || report.Active {
		t.Fatalf("unexpected report %+v", report)
	}
}

func TestRuntimeFailoverClearPreservesWorkAndConfig(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "work-in-progress.txt")
	if err := os.WriteFile(work, []byte("unfinished changes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := executeFailover(t, root, "configure"); err != nil {
		t.Fatal(err)
	}
	if err := runtimefailover.SaveState(root, &runtimefailover.State{Source: "codex", Target: "cursor", ActivatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := executeFailover(t, root, "clear"); err != nil {
		t.Fatal(err)
	}
	if s, err := runtimefailover.LoadState(root); err != nil || s != nil {
		t.Fatalf("state not cleared: %+v %v", s, err)
	}
	if b, err := os.ReadFile(work); err != nil || string(b) != "unfinished changes" {
		t.Fatal("clear changed worktree")
	}
}

func TestRuntimeFailoverLockPreventsOverlappingMutation(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	lock := flock.New(filepath.Join(root, ".runtime", "runtime-failover.lock"))
	if err := lock.Lock(); err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	if _, err := executeFailover(t, root, "clear"); err == nil {
		t.Fatal("mutated state while another cycle holds lock")
	}
}

func TestRuntimeFailoverReloadsPolicyInsideLock(t *testing.T) {
	root := t.TempDir()
	if _, err := executeFailover(t, root, "configure"); err != nil {
		t.Fatal(err)
	}
	c := newRuntimeFailoverCommandWith(func() (string, error) { return root, nil }, func(string) runtimefailover.Backend {
		// Model a configure operation that finishes after the initial read and
		// before the scan acquires its lock.
		settings, err := config.LoadOrCreateTownSettings(config.TownSettingsPath(root))
		if err != nil {
			t.Fatal(err)
		}
		settings.RuntimeFailover = &runtimefailover.Config{Enabled: false, Source: "codex", Target: "cursor"}
		if err := config.SaveTownSettings(config.TownSettingsPath(root), settings); err != nil {
			t.Fatal(err)
		}
		return nil
	})
	var output bytes.Buffer
	c.SetOut(&output)
	c.SetErr(&output)
	c.SetArgs([]string{"--json"})
	if err := c.Execute(); err != nil {
		t.Fatalf("scan used stale enabled policy: %v", err)
	}
	var report runtimefailover.Report
	if err := json.Unmarshal(output.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Enabled {
		t.Fatal("scan ignored policy disabled before lock")
	}
}
