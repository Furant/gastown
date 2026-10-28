package daemon

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/steveyegge/gastown/internal/config"
)

const runtimeFailoverInterval = 30 * time.Second

// runRuntimeFailoverCycle is independent of any LLM and Claude account rotation.
// Reload the opt-in policy each time so configure/disable does not need a restart.
func runRuntimeFailoverCycle(ctx context.Context, townRoot, gtPath string) (string, error) {
	settings, err := config.LoadOrCreateTownSettings(config.TownSettingsPath(townRoot))
	if err != nil {
		return "", fmt.Errorf("loading runtime failover policy: %w", err)
	}
	if settings.RuntimeFailover == nil || !settings.RuntimeFailover.Enabled {
		return "", nil
	}
	if err := settings.RuntimeFailover.Validate(); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, gtPath, "quota", "failover", "--json") //nolint:gosec // gtPath is resolved at daemon startup
	command.Dir = townRoot
	out, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("runtime failover scan: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
