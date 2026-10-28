package config

import (
	"fmt"
	"os"

	"github.com/steveyegge/gastown/internal/runtimefailover"
)

// routeResolvedAgent applies persisted routing to an already-resolved alias.
// It deliberately looks up the target independently so source-only arguments
// and metadata cannot leak into the redirected runtime.
func routeResolvedAgent(townRoot, rigPath, agent string, rc *RuntimeConfig) (*RuntimeConfig, string, error) {
	if townRoot == "" || agent == "" || rc == nil {
		return rc, agent, nil
	}
	town, err := LoadOrCreateTownSettings(TownSettingsPath(townRoot))
	if err != nil {
		return rc, agent, fmt.Errorf("loading runtime failover policy: %w", err)
	}
	if town.RuntimeFailover == nil || !town.RuntimeFailover.Enabled {
		return rc, agent, nil
	}
	if err := town.RuntimeFailover.Validate(); err != nil {
		return rc, agent, err
	}
	target, err := runtimefailover.Route(townRoot, town.RuntimeFailover, agent)
	if err != nil {
		return rc, agent, err
	}
	if target == agent {
		return rc, agent, nil
	}
	var rig *RigSettings
	if rigPath != "" {
		rig, _ = LoadRigSettings(RigSettingsPath(rigPath))
	}
	_ = LoadAgentRegistry(DefaultAgentRegistryPath(townRoot))
	if rigPath != "" {
		_ = LoadRigAgentRegistry(RigAgentRegistryPath(rigPath))
	}
	targetConfig := lookupAgentConfigIfExists(target, town, rig)
	if targetConfig == nil {
		return rc, agent, fmt.Errorf("runtime failover target agent %q not found", target)
	}
	targetConfig.ResolvedAgent = target
	return targetConfig, target, nil
}

func routeResolvedAgentBestEffort(townRoot, rigPath string, rc *RuntimeConfig) *RuntimeConfig {
	if rc == nil || rc.ResolvedAgent == "" {
		return rc
	}
	routed, _, err := routeResolvedAgent(townRoot, rigPath, rc.ResolvedAgent, rc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: runtime failover routing: %v\n", err)
		return rc
	}
	return routed
}

// ValidateRuntimeFailoverResolution lets launch boundaries fail closed while
// preserving the legacy non-error resolver APIs used by status/read-only code.
func ValidateRuntimeFailoverResolution(townRoot, rigPath string, rc *RuntimeConfig) error {
	if rc == nil {
		return fmt.Errorf("runtime configuration is missing")
	}
	resolveConfigMu.Lock()
	defer resolveConfigMu.Unlock()
	_, _, err := routeResolvedAgent(townRoot, rigPath, rc.ResolvedAgent, rc)
	return err
}
