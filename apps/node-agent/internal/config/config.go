// Package config loads and validates the node-agent configuration.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

type KeypairMode string

const (
	KeypairModeGenerate KeypairMode = "generate"
	KeypairModeImport   KeypairMode = "import"
)

// Config is the effective, validated agent configuration.
type Config struct {
	// ControlPlaneURL is the base URL the agent dials OUT to. The agent is PULL:
	// the control plane never connects to the node, so a node only needs outbound
	// 443 open. See README for the rationale.
	ControlPlaneURL string

	// mTLS client identity used for every steady-state call.
	ClientCertPath string
	ClientKeyPath  string

	// CPPublicKeyPath is the pinned RS256 public key of the control plane. Desired
	// state is verified against this key and nothing else — a compromised transport
	// still cannot forge a config. In production this file is deployed read-only
	// alongside the binary (effectively baked in).
	CPPublicKeyPath string

	XrayConfigPath  string
	XraySystemdUnit string

	// RealityKeypairMode selects brownfield behaviour. See EnsureRealityKeypair.
	RealityKeypairMode    KeypairMode
	RealityPrivateKeyPath string

	// AgentEpoch prefixes every stats report_id ("<agent_epoch>:<seq>"). It must
	// change whenever a node is re-bootstrapped so report_ids never collide with a
	// previous incarnation's already-acked reports.
	AgentEpoch string
	NodeID     string

	PullInterval time.Duration
	StateDir     string

	BootstrapTokenPath string
}

type fileConfig struct {
	ControlPlaneURL       string `json:"control_plane_url"`
	ClientCertPath        string `json:"client_cert_path"`
	ClientKeyPath         string `json:"client_key_path"`
	CPPublicKeyPath       string `json:"cp_public_key_path"`
	XrayConfigPath        string `json:"xray_config_path"`
	XraySystemdUnit       string `json:"xray_systemd_unit"`
	RealityKeypairMode    string `json:"reality_keypair_mode"`
	RealityPrivateKeyPath string `json:"reality_private_key_path"`
	AgentEpoch            string `json:"agent_epoch"`
	NodeID                string `json:"node_id"`
	PullInterval          string `json:"pull_interval"`
	StateDir              string `json:"state_dir"`
	BootstrapTokenPath    string `json:"bootstrap_token_path"`
}

// Load reads the JSON config file (if path is non-empty), applies NODE_AGENT_*
// environment overrides on top, then validates.
func Load(path string) (*Config, error) {
	fc := fileConfig{
		XraySystemdUnit:    "xray.service",
		RealityKeypairMode: string(KeypairModeGenerate),
		PullInterval:       "30s",
		StateDir:           "/var/lib/node-agent",
	}

	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config %s: %w", path, err)
		}
		if err := json.Unmarshal(raw, &fc); err != nil {
			return nil, fmt.Errorf("parse config %s: %w", path, err)
		}
	}

	applyEnv(&fc)

	interval, err := time.ParseDuration(fc.PullInterval)
	if err != nil {
		return nil, fmt.Errorf("invalid pull_interval %q: %w", fc.PullInterval, err)
	}

	cfg := &Config{
		ControlPlaneURL:       fc.ControlPlaneURL,
		ClientCertPath:        fc.ClientCertPath,
		ClientKeyPath:         fc.ClientKeyPath,
		CPPublicKeyPath:       fc.CPPublicKeyPath,
		XrayConfigPath:        fc.XrayConfigPath,
		XraySystemdUnit:       fc.XraySystemdUnit,
		RealityKeypairMode:    KeypairMode(fc.RealityKeypairMode),
		RealityPrivateKeyPath: fc.RealityPrivateKeyPath,
		AgentEpoch:            fc.AgentEpoch,
		NodeID:                fc.NodeID,
		PullInterval:          interval,
		StateDir:              fc.StateDir,
		BootstrapTokenPath:    fc.BootstrapTokenPath,
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func applyEnv(fc *fileConfig) {
	fc.ControlPlaneURL = envOr("NODE_AGENT_CONTROL_PLANE_URL", fc.ControlPlaneURL)
	fc.ClientCertPath = envOr("NODE_AGENT_CLIENT_CERT_PATH", fc.ClientCertPath)
	fc.ClientKeyPath = envOr("NODE_AGENT_CLIENT_KEY_PATH", fc.ClientKeyPath)
	fc.CPPublicKeyPath = envOr("NODE_AGENT_CP_PUBLIC_KEY_PATH", fc.CPPublicKeyPath)
	fc.XrayConfigPath = envOr("NODE_AGENT_XRAY_CONFIG_PATH", fc.XrayConfigPath)
	fc.XraySystemdUnit = envOr("NODE_AGENT_XRAY_SYSTEMD_UNIT", fc.XraySystemdUnit)
	fc.RealityKeypairMode = envOr("NODE_AGENT_REALITY_KEYPAIR_MODE", fc.RealityKeypairMode)
	fc.RealityPrivateKeyPath = envOr("NODE_AGENT_REALITY_PRIVATE_KEY_PATH", fc.RealityPrivateKeyPath)
	fc.AgentEpoch = envOr("NODE_AGENT_AGENT_EPOCH", fc.AgentEpoch)
	fc.NodeID = envOr("NODE_AGENT_NODE_ID", fc.NodeID)
	fc.PullInterval = envOr("NODE_AGENT_PULL_INTERVAL", fc.PullInterval)
	fc.StateDir = envOr("NODE_AGENT_STATE_DIR", fc.StateDir)
	fc.BootstrapTokenPath = envOr("NODE_AGENT_BOOTSTRAP_TOKEN_PATH", fc.BootstrapTokenPath)
}

func envOr(key, cur string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return cur
}

func (c *Config) validate() error {
	required := map[string]string{
		"control_plane_url":  c.ControlPlaneURL,
		"client_cert_path":   c.ClientCertPath,
		"client_key_path":    c.ClientKeyPath,
		"cp_public_key_path": c.CPPublicKeyPath,
		"xray_config_path":   c.XrayConfigPath,
		"state_dir":          c.StateDir,
	}
	var missing []string
	for k, v := range required {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("missing required config: %s", strings.Join(missing, ", "))
	}

	switch c.RealityKeypairMode {
	case KeypairModeGenerate:
	case KeypairModeImport:
		if c.RealityPrivateKeyPath == "" {
			return fmt.Errorf("reality_keypair_mode=import requires reality_private_key_path")
		}
	default:
		return fmt.Errorf("invalid reality_keypair_mode %q (want generate|import)", c.RealityKeypairMode)
	}

	if c.PullInterval <= 0 {
		return fmt.Errorf("pull_interval must be > 0")
	}
	return nil
}
