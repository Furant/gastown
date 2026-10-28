// Package runtimefailover implements persisted, one-way provider routing after
// a runtime reports that its usage limit has been reached.
package runtimefailover

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Config defines a one-way agent alias redirect.
type Config struct {
	Enabled bool   `json:"enabled"`
	Source  string `json:"source"`
	Target  string `json:"target"`
}

var aliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

// Validate verifies that an enabled policy names two distinct safe aliases.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	for label, value := range map[string]string{"source": c.Source, "target": c.Target} {
		if !aliasPattern.MatchString(value) {
			return fmt.Errorf("runtime failover %s must be a non-empty agent alias", label)
		}
	}
	if c.Source == c.Target {
		return errors.New("runtime failover source and target must differ")
	}
	return nil
}

// State records the currently active redirect.
type State struct {
	Source      string         `json:"source"`
	Target      string         `json:"target"`
	ActivatedAt time.Time      `json:"activated_at"`
	Failures    map[string]int `json:"failures,omitempty"`
}

func statePath(root string) string { return filepath.Join(root, ".runtime", "runtime-failover.json") }

// LoadState returns nil,nil if no failover has been activated.
func LoadState(townRoot string) (*State, error) {
	b, err := os.ReadFile(statePath(townRoot))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading runtime failover state: %w", err)
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("decoding runtime failover state: %w", err)
	}
	c := Config{Enabled: true, Source: s.Source, Target: s.Target}
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("invalid runtime failover state: %w", err)
	}
	if s.ActivatedAt.IsZero() {
		return nil, errors.New("invalid runtime failover state: activated_at is required")
	}
	if err := validateFailures(s.Failures); err != nil {
		return nil, fmt.Errorf("invalid runtime failover state: %w", err)
	}
	return &s, nil
}

// SaveState atomically writes the active state with owner-only permissions.
func SaveState(townRoot string, state *State) error {
	if state == nil {
		return errors.New("runtime failover state is nil")
	}
	if err := (Config{Enabled: true, Source: state.Source, Target: state.Target}).Validate(); err != nil {
		return err
	}
	if state.ActivatedAt.IsZero() {
		return errors.New("runtime failover activated_at is required")
	}
	if err := validateFailures(state.Failures); err != nil {
		return err
	}
	dir := filepath.Join(townRoot, ".runtime")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("creating runtime directory: %w", err)
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding runtime failover state: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".runtime-failover-*")
	if err != nil {
		return fmt.Errorf("creating runtime failover state: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return fmt.Errorf("setting state permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing runtime failover state: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("syncing runtime failover state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing runtime failover state: %w", err)
	}
	if err := os.Rename(tmpName, statePath(townRoot)); err != nil {
		return fmt.Errorf("installing runtime failover state: %w", err)
	}
	return nil
}

func validateFailures(failures map[string]int) error {
	for session, count := range failures {
		if count < 0 {
			return fmt.Errorf("runtime failover failure count for %q must be non-negative", session)
		}
	}
	return nil
}

// ClearState removes only the runtime failover marker.
func ClearState(townRoot string) error {
	err := os.Remove(statePath(townRoot))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("removing runtime failover state: %w", err)
	}
	return nil
}

// Route applies a matching active policy without chaining redirects.
func Route(townRoot string, policy *Config, agent string) (string, error) {
	if policy == nil || !policy.Enabled {
		return agent, nil
	}
	if err := policy.Validate(); err != nil {
		return agent, err
	}
	s, err := LoadState(townRoot)
	if err != nil {
		return agent, err
	}
	if s == nil || s.Source != policy.Source || s.Target != policy.Target {
		return agent, nil
	}
	if agent == policy.Source {
		return policy.Target, nil
	}
	return agent, nil
}

// IsCodexQuotaExhausted recognizes explicit limit errors in terminal output.
func IsCodexQuotaExhausted(content string) bool {
	lines := strings.Split(stripANSI(content), "\n")
	if len(lines) > 24 {
		lines = lines[len(lines)-24:]
	}
	inCodeBlock := false
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") {
			inCodeBlock = !inCodeBlock
			continue
		}
		if inCodeBlock || trim == "" || strings.HasPrefix(trim, ">") || strings.HasPrefix(trim, "//") || strings.HasPrefix(trim, "#") {
			continue
		}
		lower := strings.ToLower(trim)
		// The human-readable phrase is only a signal when it is presented as
		// a terminal error line. Prompts, documentation, and quoted examples
		// routinely contain the same wording.
		if (strings.HasPrefix(trim, "■") || strings.HasPrefix(lower, "error:") ||
			strings.HasPrefix(lower, "you've hit your usage limit") || strings.HasPrefix(lower, "you have hit your usage limit") || strings.HasPrefix(lower, "you’ve hit your usage limit")) &&
			(strings.Contains(lower, "you've hit your usage limit") || strings.Contains(lower, "you have hit your usage limit") || strings.Contains(lower, "you’ve hit your usage limit")) {
			return true
		}
		if !strings.Contains(lower, "error") && !strings.Contains(lower, "\"type\"") && !strings.Contains(lower, "\"code\"") {
			continue
		}
		jsonText := trim
		if i := strings.IndexByte(jsonText, '{'); i > 0 {
			jsonText = jsonText[i:]
		}
		var v any
		if json.Unmarshal([]byte(jsonText), &v) == nil && isQuotaErrorEnvelope(v) {
			return true
		}
	}
	return false
}

func isQuotaErrorEnvelope(v any) bool {
	root, ok := v.(map[string]any)
	if !ok {
		return false
	}
	// Accept the API/Codex error envelope, and an explicit {type:"error",
	// code/type:...} envelope. Deliberately do not walk arbitrary nested
	// objects: documentation often embeds illustrative expected values.
	err, ok := root["error"].(map[string]any)
	if ok && hasQuotaCode(err) {
		return true
	}
	if root["type"] == "error" && hasQuotaCode(root) {
		return true
	}
	return false
}

func hasQuotaCode(m map[string]any) bool {
	for _, key := range []string{"type", "code"} {
		if value, ok := m[key].(string); ok && (value == "usage_limit_reached" || value == "insufficient_quota") {
			return true
		}
	}
	return false
}

func stripANSI(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			i += 2
			for i < len(s) && (s[i] < '@' || s[i] > '~') {
				i++
			}
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
