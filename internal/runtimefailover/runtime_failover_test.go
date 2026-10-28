package runtimefailover

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigValidate(t *testing.T) {
	for _, tc := range []struct {
		name, source, target string
		enabled              bool
		wantErr              bool
	}{
		{"disabled", "", "", false, false}, {"valid", "codex", "cursor", true, false},
		{"empty", "", "cursor", true, true}, {"same", "codex", "codex", true, true},
		{"path", "../codex", "cursor", true, true}, {"shell", "codex;whoami", "cursor", true, true}, {"space", "codex x", "cursor", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := Config{Enabled: tc.enabled, Source: tc.source, Target: tc.target}
			err := c.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestStatePersistenceAndRoute(t *testing.T) {
	root := t.TempDir()
	policy := &Config{Enabled: true, Source: "codex", Target: "cursor"}
	got, err := Route(root, policy, "codex")
	if err != nil || got != "codex" {
		t.Fatalf("inactive Route=%q,%v", got, err)
	}
	state := &State{Source: "codex", Target: "cursor", ActivatedAt: time.Now().UTC().Truncate(time.Second)}
	if err := SaveState(root, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, ".runtime", "runtime-failover.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	loaded, err := LoadState(root)
	if err != nil || loaded == nil || !loaded.ActivatedAt.Equal(state.ActivatedAt) {
		t.Fatalf("LoadState=%+v,%v", loaded, err)
	}
	got, err = Route(root, policy, "codex")
	if err != nil || got != "cursor" {
		t.Fatalf("active Route=%q,%v", got, err)
	}
	got, err = Route(root, policy, "cursor")
	if err != nil || got != "cursor" {
		t.Fatalf("non-source Route=%q,%v", got, err)
	}
	changed := &Config{Enabled: true, Source: "codex", Target: "gemini"}
	got, err = Route(root, changed, "codex")
	if err != nil || got != "codex" {
		t.Fatalf("changed policy Route=%q,%v", got, err)
	}
	if err := ClearState(root); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadState(root)
	if err != nil || loaded != nil {
		t.Fatalf("cleared LoadState=%+v,%v", loaded, err)
	}
}

func TestStateFailuresPersistenceAndValidation(t *testing.T) {
	root := t.TempDir()
	state := &State{
		Source: "codex", Target: "cursor", ActivatedAt: time.Now().UTC().Truncate(time.Second),
		Failures: map[string]int{"mayor": 2, "crew": 0},
	}
	if err := SaveState(root, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadState(root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Failures["mayor"] != 2 || loaded.Failures["crew"] != 0 {
		t.Fatalf("failure counts did not round trip: %#v", loaded.Failures)
	}
	if err := SaveState(root, &State{
		Source: "codex", Target: "cursor", ActivatedAt: state.ActivatedAt,
		Failures: map[string]int{"mayor": -1},
	}); err == nil {
		t.Fatal("SaveState accepted a negative failure count")
	}

	path := statePath(root)
	legacy := `{"source":"codex","target":"cursor","activated_at":"2026-01-01T00:00:00Z"}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadState(root)
	if err != nil || loaded == nil || loaded.Failures != nil {
		t.Fatalf("legacy state without failures: state=%+v err=%v", loaded, err)
	}
	negative := `{"source":"codex","target":"cursor","activated_at":"2026-01-01T00:00:00Z","failures":{"mayor":-1}}`
	if err := os.WriteFile(path, []byte(negative), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadState(root); err == nil {
		t.Fatal("LoadState accepted a negative failure count")
	}
}

func TestLoadStateRejectsCorruptJSON(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".runtime", "runtime-failover.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadState(root); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}

func TestStateErrorPaths(t *testing.T) {
	t.Run("save rejects invalid states and unusable runtime directory", func(t *testing.T) {
		root := t.TempDir()
		for name, state := range map[string]*State{
			"nil":            nil,
			"invalid alias":  {Source: "../codex", Target: "cursor", ActivatedAt: time.Now()},
			"zero timestamp": {Source: "codex", Target: "cursor"},
		} {
			t.Run(name, func(t *testing.T) {
				if err := SaveState(root, state); err == nil {
					t.Fatal("expected SaveState error")
				}
			})
		}
		blocked := filepath.Join(root, ".runtime")
		if err := os.WriteFile(blocked, []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
		state := &State{Source: "codex", Target: "cursor", ActivatedAt: time.Now()}
		if err := SaveState(root, state); err == nil {
			t.Fatal("expected error when runtime path is a file")
		}
	})

	t.Run("load rejects invalid state and read errors", func(t *testing.T) {
		for name, data := range map[string]string{
			"invalid alias":  `{"source":"../codex","target":"cursor","activated_at":"2026-01-01T00:00:00Z"}`,
			"zero timestamp": `{"source":"codex","target":"cursor"}`,
		} {
			t.Run(name, func(t *testing.T) {
				root := t.TempDir()
				path := filepath.Join(root, ".runtime", "runtime-failover.json")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := LoadState(root); err == nil {
					t.Fatal("expected invalid state error")
				}
			})
		}
		root := t.TempDir()
		if err := os.MkdirAll(statePath(root), 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadState(root); err == nil {
			t.Fatal("expected read error for directory marker")
		}
	})

	t.Run("clear failure leaves unrelated files untouched", func(t *testing.T) {
		root := t.TempDir()
		runtimeDir := filepath.Join(root, ".runtime")
		if err := os.MkdirAll(runtimeDir, 0700); err != nil {
			t.Fatal(err)
		}
		marker := statePath(root)
		if err := os.Mkdir(marker, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(marker, "child"), []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
		other := filepath.Join(runtimeDir, "keep.json")
		if err := os.WriteFile(other, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := ClearState(root); err == nil {
			t.Fatal("expected remove error for directory marker")
		}
		if _, err := os.Stat(other); err != nil {
			t.Fatalf("unrelated file changed: %v", err)
		}
	})
}

func TestIsCodexQuotaExhaustedConservative(t *testing.T) {
	positives := []string{
		"\nError: {\"error\":{\"type\":\"usage_limit_reached\"}}",
		"\n■ You've hit your usage limit. Upgrade or wait until reset.",
		"\nError: You've hit your usage limit.",
		`{"error":{"type":"usage_limit_reached"}}`,
		`{"error":{"code":"insufficient_quota"}}`,
	}
	for _, s := range positives {
		if !IsCodexQuotaExhausted(s) {
			t.Errorf("expected match: %q", s)
		}
	}
	negatives := []string{
		"HTTP 429 Too Many Requests",
		"network error: connection refused",
		"Codex quota almost exhausted; plenty of balance remains",
		"Documentation: `usage_limit_reached` means the limit was hit",
		"> {\"code\":\"insufficient_quota\"}",
		"For example, You've hit your usage limit.",
		"› You've hit your usage limit.",
		`{"expected":{"type":"usage_limit_reached"}}`,
	}
	for _, s := range negatives {
		if IsCodexQuotaExhausted(s) {
			t.Errorf("unexpected match: %q", s)
		}
	}
}
