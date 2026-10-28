package runtimefailover

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// LiveSession identifies the effective runtime, rather than the configured default.
type LiveSession struct {
	Name  string
	Agent string
}

// Backend separates read-only preflight from destructive session replacement.
// Prepare must not stop the source session. Recover preserves its work directory
// and branch, and starts a fresh native target session (never a source resume ID).
type Backend interface {
	Sessions() ([]LiveSession, error)
	Capture(name string) (string, error)
	Prepare(name, target string) error
	Recover(name, target string) error
}

type RecoveryResult struct {
	Session string `json:"session"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

type Report struct {
	Enabled bool             `json:"enabled"`
	Active  bool             `json:"active"`
	Source  string           `json:"source,omitempty"`
	Target  string           `json:"target,omitempty"`
	DryRun  bool             `json:"dry_run"`
	Results []RecoveryResult `json:"results"`
}

// Controller runs one scan. Callers serialize Run and ClearState with the same
// town-wide lock. An active latch changes future routing, but only sessions with
// a current explicit quota error are stopped; healthy work is left alone.
type Controller struct {
	TownRoot string
	Policy   *Config
	Backend  Backend
}

func (c *Controller) Run(dryRun bool) (Report, error) {
	report := Report{DryRun: dryRun, Results: []RecoveryResult{}}
	if c.Policy == nil || !c.Policy.Enabled {
		return report, nil
	}
	if err := c.Policy.Validate(); err != nil {
		return report, err
	}
	report.Enabled, report.Source, report.Target = true, c.Policy.Source, c.Policy.Target
	state, err := LoadState(c.TownRoot)
	if err != nil {
		return report, err
	}
	report.Active = state != nil && state.Source == c.Policy.Source && state.Target == c.Policy.Target
	if c.Backend == nil {
		return report, errors.New("runtime failover backend is required")
	}
	sessions, err := c.Backend.Sessions()
	if err != nil {
		return report, fmt.Errorf("listing runtime sessions: %w", err)
	}
	sessions = append([]LiveSession(nil), sessions...)
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Name < sessions[j].Name })
	for _, s := range sessions {
		if s.Agent != c.Policy.Source {
			continue
		}
		content, err := c.Backend.Capture(s.Name)
		if err != nil {
			report.Results = append(report.Results, RecoveryResult{Session: s.Name, Status: "error", Error: fmt.Sprintf("capture: %v", err)})
			continue
		}
		if !IsCodexQuotaExhausted(content) {
			continue
		}
		result := RecoveryResult{Session: s.Name, Status: "would_recover"}
		if !dryRun {
			if report.Active && state.Failures[s.Name] >= 3 {
				result.Status = "blocked"
				result.Error = "recovery failed three times; repair the target and run gt quota failover clear before retrying"
				report.Results = append(report.Results, result)
				continue
			}
			if err := c.Backend.Prepare(s.Name, c.Policy.Target); err != nil {
				result.Status, result.Error = "error", fmt.Sprintf("preflight: %v", err)
				report.Results = append(report.Results, result)
				continue
			}
			if !report.Active {
				state = &State{Source: c.Policy.Source, Target: c.Policy.Target, ActivatedAt: time.Now().UTC()}
				if err := SaveState(c.TownRoot, state); err != nil {
					return report, err
				}
				report.Active = true
			}
			if err := c.Backend.Recover(s.Name, c.Policy.Target); err != nil {
				result.Status, result.Error = "error", fmt.Sprintf("recovery: %v", err)
				updated := *state
				updated.Failures = make(map[string]int, len(state.Failures)+1)
				for session, count := range state.Failures {
					updated.Failures[session] = count
				}
				updated.Failures[s.Name]++
				if err := SaveState(c.TownRoot, &updated); err != nil {
					return report, err
				}
				state = &updated
			} else {
				result.Status = "recovered"
			}
		}
		report.Results = append(report.Results, result)
	}
	return report, nil
}
