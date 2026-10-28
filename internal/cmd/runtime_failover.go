package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
	"github.com/spf13/cobra"
	"github.com/steveyegge/gastown/internal/atomicfile"
	"github.com/steveyegge/gastown/internal/config"
	"github.com/steveyegge/gastown/internal/runtimefailover"
	"github.com/steveyegge/gastown/internal/workspace"
)

func init() { quotaCmd.AddCommand(newRuntimeFailoverCommand()) }

func newRuntimeFailoverCommand() *cobra.Command {
	return newRuntimeFailoverCommandWith(workspace.FindFromCwd, func(root string) runtimefailover.Backend { return newRuntimeFailoverBackend(root) })
}

func newRuntimeFailoverCommandWith(findRoot func() (string, error), backend func(string) runtimefailover.Backend) *cobra.Command {
	var dryRun, asJSON bool
	c := &cobra.Command{Use: "failover", Short: "Recover quota-blocked Codex sessions with another runtime", Args: cobra.NoArgs}
	c.Long = "Opt-in one-way runtime failover. Configure a Codex source and Cursor target, preview a scan, and clear the routing latch after the source quota recovers. No credentials are rotated."
	c.Flags().BoolVar(&dryRun, "dry-run", false, "Preview blocked sessions without changing processes or routing")
	c.Flags().BoolVar(&asJSON, "json", false, "Print a structured recovery report")
	c.RunE = func(cmd *cobra.Command, args []string) error {
		root, err := findRoot()
		if err != nil {
			return err
		}
		settings, err := config.LoadOrCreateTownSettings(config.TownSettingsPath(root))
		if err != nil {
			return err
		}
		controller := runtimefailover.Controller{TownRoot: root, Policy: settings.RuntimeFailover}
		if settings.RuntimeFailover != nil && settings.RuntimeFailover.Enabled {
			controller.Backend = backend(root)
		}
		var report runtimefailover.Report
		run := func() error {
			// Configuration may have changed since the read before locking.
			current, loadErr := config.LoadOrCreateTownSettings(config.TownSettingsPath(root))
			if loadErr != nil {
				return loadErr
			}
			controller.Policy = current.RuntimeFailover
			var e error
			report, e = controller.Run(dryRun)
			return e
		}
		if dryRun || settings.RuntimeFailover == nil || !settings.RuntimeFailover.Enabled {
			err = run()
		} else {
			err = withRuntimeFailoverLock(root, run)
		}
		if err != nil {
			return err
		}
		if asJSON {
			return json.NewEncoder(cmd.OutOrStdout()).Encode(report)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Runtime failover: enabled=%t active=%t source=%s target=%s\n", report.Enabled, report.Active, report.Source, report.Target)
		for _, result := range report.Results {
			fmt.Fprintf(cmd.OutOrStdout(), "%s: %s %s\n", result.Session, result.Status, result.Error)
		}
		return nil
	}
	c.AddCommand(runtimeFailoverConfigureCommand(findRoot), runtimeFailoverStatusCommand(findRoot), &cobra.Command{
		Use: "clear", Short: "Clear the routing latch without stopping sessions or changing work", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := findRoot()
			if err != nil {
				return err
			}
			return withRuntimeFailoverLock(root, func() error { return runtimefailover.ClearState(root) })
		},
	})
	return c
}

func runtimeFailoverConfigureCommand(findRoot func() (string, error)) *cobra.Command {
	policy := runtimefailover.Config{}
	c := &cobra.Command{Use: "configure", Short: "Configure opt-in quota failover (does not switch running agents)", Args: cobra.NoArgs}
	c.Flags().BoolVar(&policy.Enabled, "enabled", true, "Enable automatic runtime failover")
	c.Flags().StringVar(&policy.Source, "source", "codex", "Codex source agent alias")
	c.Flags().StringVar(&policy.Target, "target", "cursor", "Target agent alias")
	c.RunE = func(cmd *cobra.Command, args []string) error {
		if err := policy.Validate(); err != nil {
			return err
		}
		root, err := findRoot()
		if err != nil {
			return err
		}
		return withRuntimeFailoverLock(root, func() error {
			path := config.TownSettingsPath(root)
			settings, err := config.LoadOrCreateTownSettings(path)
			if err != nil {
				return err
			}
			if settings.Version > config.CurrentTownSettingsVersion {
				return errors.New("town settings version is newer than this gt binary")
			}
			if policy.Enabled {
				_ = config.LoadAgentRegistry(config.DefaultAgentRegistryPath(root))
				for _, alias := range []string{policy.Source, policy.Target} {
					if config.GetAgentPresetByName(alias) == nil && settings.Agents[alias] == nil {
						return fmt.Errorf("runtime failover agent %q not found", alias)
					}
				}
			}
			if err := saveRuntimeFailoverPolicy(path, settings, policy); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Runtime failover configured: enabled=%t %s -> %s (30s daemon scan)\n", policy.Enabled, policy.Source, policy.Target)
			return nil
		})
	}
	return c
}

// Preserve unknown settings and file permissions, and publish policy atomically.
func saveRuntimeFailoverPolicy(path string, defaults *config.TownSettings, policy runtimefailover.Config) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		data, err = json.Marshal(defaults)
	}
	if err != nil {
		return err
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		return err
	}
	if values == nil {
		return errors.New("town settings must be an object")
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	values["runtime_failover"] = encoded
	mode := os.FileMode(0600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	return atomicfile.EnsureDirAndWriteJSONWithPerm(path, values, mode)
}

func runtimeFailoverStatusCommand(findRoot func() (string, error)) *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show runtime policy and durable routing state", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := findRoot()
			if err != nil {
				return err
			}
			settings, err := config.LoadOrCreateTownSettings(config.TownSettingsPath(root))
			if err != nil {
				return err
			}
			state, err := runtimefailover.LoadState(root)
			if err != nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(struct {
				Policy *runtimefailover.Config `json:"policy"`
				State  *runtimefailover.State  `json:"state"`
			}{settings.RuntimeFailover, state})
		},
	}
}

func withRuntimeFailoverLock(root string, fn func() error) error {
	dir := filepath.Join(root, ".runtime")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, "runtime-failover.lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return err
	}
	if !locked {
		return errors.New("another runtime failover operation is in progress")
	}
	defer lock.Unlock()
	return fn()
}
