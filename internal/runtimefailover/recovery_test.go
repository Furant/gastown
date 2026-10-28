package runtimefailover

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type recoveryBackend struct {
	sessions               []LiveSession
	panes                  map[string]string
	prepared, recovered    []string
	prepareErr, recoverErr error
	attempts               int
}

func (b *recoveryBackend) Sessions() ([]LiveSession, error)    { return b.sessions, nil }
func (b *recoveryBackend) Capture(name string) (string, error) { return b.panes[name], nil }
func (b *recoveryBackend) Prepare(name, target string) error {
	b.prepared = append(b.prepared, name)
	return b.prepareErr
}
func (b *recoveryBackend) Recover(name, target string) error {
	b.attempts++
	if b.recoverErr != nil {
		return b.recoverErr
	}
	b.recovered = append(b.recovered, name)
	for i, s := range b.sessions {
		if s.Name == name {
			b.sessions[i] = LiveSession{Name: name, Agent: target}
		}
	}
	return nil
}

func TestControllerBoundsPersistentRecoveryRetries(t *testing.T) {
	root := t.TempDir()
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit."}, recoverErr: errors.New("respawn failed")}
	for range 5 {
		c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
		if _, err := c.Run(false); err != nil {
			t.Fatal(err)
		}
	}
	if b.attempts != 3 {
		t.Fatalf("recovery tried %d times; want at most 3", b.attempts)
	}
	if err := ClearState(root); err != nil {
		t.Fatal(err)
	}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	if _, err := c.Run(false); err != nil {
		t.Fatal(err)
	}
	if b.attempts != 4 {
		t.Fatal("clearing latch did not allow a retry")
	}
}

func TestControllerRecoversLimitedSourceAndLatchesRoute(t *testing.T) {
	root := t.TempDir()
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}, {"crew", "cursor"}, {"working", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit. Please try again later.", "crew": "You've hit your usage limit.", "working": "Running tests"}}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	report, err := c.Run(false)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Active || len(b.recovered) != 1 || b.recovered[0] != "mayor" {
		t.Fatalf("unexpected recovery: %+v / %+v", report, b.recovered)
	}
	if routed, err := Route(root, c.Policy, "codex"); err != nil || routed != "cursor" {
		t.Fatalf("routing not latched: %q %v", routed, err)
	}
	if _, err := c.Run(false); err != nil {
		t.Fatal(err)
	}
	if len(b.recovered) != 1 {
		t.Fatal("recovered the target or a healthy source a second time")
	}
}

func TestControllerDryRunHasNoWritesOrRecovery(t *testing.T) {
	root := t.TempDir()
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit."}}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	r, err := c.Run(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Results) != 1 || r.Results[0].Status != "would_recover" {
		t.Fatalf("unexpected preview: %+v", r)
	}
	if len(b.prepared) != 0 || len(b.recovered) != 0 {
		t.Fatal("dry-run performed recovery work")
	}
	if s, err := LoadState(root); err != nil || s != nil {
		t.Fatalf("dry-run changed state: %+v %v", s, err)
	}
}

func TestControllerMissingTargetDoesNotActivateOrKill(t *testing.T) {
	root := t.TempDir()
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit."}, prepareErr: errors.New("target unavailable")}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	r, err := c.Run(false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Active || len(b.recovered) != 0 || len(r.Results) != 1 || r.Results[0].Error == "" {
		t.Fatalf("unsafe failed preflight: %+v", r)
	}
	if s, _ := LoadState(root); s != nil {
		t.Fatal("unavailable target activated routing")
	}
}

func TestControllerStateFailurePreventsRecovery(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".runtime"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit."}}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	if _, err := c.Run(false); err == nil {
		t.Fatal("expected persistence error")
	}
	if len(b.recovered) != 0 {
		t.Fatal("restarted before durable state")
	}
}

func TestControllerDisabledDoesNothing(t *testing.T) {
	if r, err := (&Controller{TownRoot: t.TempDir()}).Run(false); err != nil || r.Active || r.Enabled {
		t.Fatalf("disabled controller: %+v %v", r, err)
	}
}

func TestControllerReportsFailedRecoveryAndRetainsLatch(t *testing.T) {
	root := t.TempDir()
	b := &recoveryBackend{sessions: []LiveSession{{"mayor", "codex"}}, panes: map[string]string{"mayor": "You've hit your usage limit."}, recoverErr: errors.New("respawn failed")}
	c := Controller{TownRoot: root, Policy: &Config{Enabled: true, Source: "codex", Target: "cursor"}, Backend: b}
	r, err := c.Run(false)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Active || len(r.Results) != 1 || r.Results[0].Error == "" {
		t.Fatalf("missing recovery error: %+v", r)
	}
}
