// Command node-agent is a dial-out (PULL) daemon that runs on a VPN node and
// keeps the local Xray process converged to the control plane's desired state.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"vpn-platform/node-agent/internal/config"
	"vpn-platform/node-agent/internal/controlplane"
	"vpn-platform/node-agent/internal/reconcile"
	"vpn-platform/node-agent/internal/stats"
	"vpn-platform/node-agent/internal/xray"
)

// version is overridable at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	configPath := flag.String("config", "/etc/node-agent/config.json", "path to node-agent config file")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()}))
	slog.SetDefault(logger)

	if err := run(*configPath, logger); err != nil {
		logger.Error("node-agent exited with error", "err", err)
		os.Exit(1)
	}
}

func run(configPath string, logger *slog.Logger) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cp, err := controlplane.New(controlplane.Options{
		BaseURL:         cfg.ControlPlaneURL,
		ClientCertPath:  cfg.ClientCertPath,
		ClientKeyPath:   cfg.ClientKeyPath,
		CPPublicKeyPath: cfg.CPPublicKeyPath,
	})
	if err != nil {
		return fmt.Errorf("init control-plane client: %w", err)
	}

	xr := xray.NewManager(cfg.XraySystemdUnit)

	// Ensure the Reality keypair before anything else. Idempotent, and in import
	// mode it refuses to run when the migrated key is missing (never rotates pbk).
	keys, err := xr.EnsureRealityKeypair(cfg.RealityKeypairMode, cfg.RealityPrivateKeyPath)
	if err != nil {
		return fmt.Errorf("ensure reality keypair: %w", err)
	}
	logger.Info("reality keypair ready",
		"mode", cfg.RealityKeypairMode,
		"public_key", keys.PublicKeyBase64,
		"short_ids", keys.ShortIDs)

	if err := maybeRegister(ctx, cfg, cp, keys, logger); err != nil {
		return fmt.Errorf("bootstrap register: %w", err)
	}

	sb, err := stats.New(filepath.Join(cfg.StateDir, "stats-buffer.json"), agentEpochOrFallback(cfg))
	if err != nil {
		return fmt.Errorf("init stats buffer: %w", err)
	}

	rec := reconcile.New(cfg, cp, xr, sb, logger, version)
	logger.Info("node-agent started",
		"version", version,
		"control_plane", cfg.ControlPlaneURL,
		"pull_interval", cfg.PullInterval.String())

	if err := rec.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	logger.Info("node-agent stopped")
	return nil
}

// maybeRegister runs the one-time bootstrap handshake if a bootstrap token file
// is present. On an already-registered node (token consumed) it is a no-op.
func maybeRegister(ctx context.Context, cfg *config.Config, cp *controlplane.Client, keys xray.RealityKeys, logger *slog.Logger) error {
	if cfg.BootstrapTokenPath == "" {
		return nil
	}
	raw, err := os.ReadFile(cfg.BootstrapTokenPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // token already consumed -> already bootstrapped
		}
		return fmt.Errorf("read bootstrap token: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return nil
	}

	res, err := cp.Register(ctx, token, keys.PublicKeyBase64, keys.ShortIDs)
	if err != nil {
		return err
	}
	logger.Info("registered with control plane", "node_id", res.NodeID, "agent_epoch", res.AgentEpoch)

	// TODO: persist res.NodeID / res.AgentEpoch into local state and delete the
	// one-time bootstrap token file so it cannot be replayed.
	return nil
}

// agentEpochOrFallback guarantees a non-empty epoch for report_id uniqueness.
// TODO: the epoch should be assigned by the control plane at registration and
// persisted; the boot-time fallback only covers pre-registration local runs.
func agentEpochOrFallback(cfg *config.Config) string {
	if cfg.AgentEpoch != "" {
		return cfg.AgentEpoch
	}
	return strconv.FormatInt(time.Now().Unix(), 10)
}

func logLevel() slog.Level {
	switch strings.ToLower(os.Getenv("NODE_AGENT_LOG_LEVEL")) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
