package session

import (
	"strings"
	"testing"

	"github.com/steveyegge/gastown/internal/config"
)

func TestRuntimeSessionEnvUsesEffectiveFailoverAgent(t *testing.T) {
	rc := config.RuntimeConfigFromPreset(config.AgentCursor)
	rc.ResolvedAgent = "cursor"
	env := runtimeSessionEnv(SessionConfig{SessionID: "hq-mayor", Role: "mayor", TownRoot: t.TempDir(), AgentOverride: "codex"}, rc)
	if env["GT_AGENT"] != "cursor" {
		t.Fatalf("wrong agent metadata: %+v", env)
	}
	if strings.Contains(env["GT_PROCESS_NAMES"], "codex") || !strings.Contains(env["GT_PROCESS_NAMES"], "cursor") {
		t.Fatalf("wrong process names: %q", env["GT_PROCESS_NAMES"])
	}
}
