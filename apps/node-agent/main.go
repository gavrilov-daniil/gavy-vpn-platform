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

	ident, err := config.LoadIdentity(cfg.StateDir)
	if err != nil {
		return err
	}
	// Чужая identity в state_dir — это склеенные ноды: агент ходил бы под токеном
	// одной ноды по путям другой и получал 401 на каждом цикле.
	if ident != nil && ident.NodeID != cfg.NodeID {
		return fmt.Errorf("identity in %s belongs to node %s, config says %s",
			config.IdentityPath(cfg.StateDir), ident.NodeID, cfg.NodeID)
	}

	cp, err := controlplane.New(controlplane.Options{
		BaseURL:         cfg.ControlPlaneURL,
		NodeID:          cfg.NodeID,
		AgentToken:      effectiveToken(cfg, ident),
		ClientCertPath:  cfg.ClientCertPath,
		ClientKeyPath:   cfg.ClientKeyPath,
		CPPublicKeyPath: cfg.CPPublicKeyPath,
	})
	if err != nil {
		return fmt.Errorf("init control-plane client: %w", err)
	}

	xr := xray.NewManager(cfg.XraySystemdUnit, cfg.RealityPrivateKeyPath, cfg.XrayAPIAddr)

	// Ensure the Reality keypair before anything else. Idempotent, and in import
	// mode it refuses to run when the migrated key is missing (never rotates pbk).
	// Ключ обязан существовать ДО энроллмента: его публичную половину мы там и
	// отправляем, а приватную не отправляем никогда.
	keys, err := xr.EnsureRealityKeypair(cfg.RealityKeypairMode)
	if err != nil {
		return fmt.Errorf("ensure reality keypair: %w", err)
	}
	logger.Info("reality keypair ready",
		"mode", cfg.RealityKeypairMode,
		"public_key", keys.PublicKeyBase64,
		"short_ids", keys.ShortIDs)

	ident, err = enrollIfNeeded(ctx, cfg, ident, cp, keys, logger)
	if err != nil {
		return err
	}
	if effectiveToken(cfg, ident) == "" {
		return fmt.Errorf("no agent credentials: set bootstrap_token (enrollment) or agent_token (transitional shared secret)")
	}

	sb, err := stats.New(filepath.Join(cfg.StateDir, "stats-buffer.json"), agentEpochOrFallback(cfg, ident), logger)
	if err != nil {
		return fmt.Errorf("init stats buffer: %w", err)
	}

	rec := reconcile.New(cfg, cp, xr, sb, logger, version)
	logger.Info("node-agent started",
		"version", version,
		"node_id", cfg.NodeID,
		"control_plane", cfg.ControlPlaneURL,
		"pull_interval", cfg.PullInterval.String())

	if err := rec.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	logger.Info("node-agent stopped")
	return nil
}

// effectiveToken picks the credential the agent authenticates with. The enrolled
// per-node token always wins over the shared AGENT_TOKEN: the shared secret is a
// transitional fallback for nodes that have not enrolled yet, and the control
// plane stops accepting it for a node once that node has its own token.
func effectiveToken(cfg *config.Config, ident *config.Identity) string {
	if ident != nil && ident.AgentToken != "" {
		return ident.AgentToken
	}
	return cfg.AgentToken
}

// enrollIfNeeded performs the one-time bootstrap handshake: bootstrap token in,
// per-node token out, persisted to state_dir with 0600.
//
// Порядок «сначала на диск, потом в работу» здесь обязателен: bootstrap-токен
// одноразовый, и если выданный per-node токен не переживёт рестарт, повторно
// заэнроллиться будет нечем — нода останется без доступа до вмешательства
// оператора.
func enrollIfNeeded(
	ctx context.Context,
	cfg *config.Config,
	ident *config.Identity,
	cp *controlplane.Client,
	keys xray.RealityKeys,
	logger *slog.Logger,
) (*config.Identity, error) {
	if ident != nil && ident.AgentToken != "" {
		if cfg.BootstrapToken != "" {
			cfg.BootstrapToken = ""
			logger.Warn("bootstrap_token задан, но нода уже заэнроллена — токен проигнорирован, удалите его из конфига")
		}
		return ident, nil
	}
	if cfg.BootstrapToken == "" {
		return ident, nil
	}

	res, err := cp.Enroll(ctx, controlplane.EnrollRequest{
		NodeID:           cfg.NodeID,
		BootstrapToken:   cfg.BootstrapToken,
		RealityPublicKey: keys.PublicKeyBase64,
		ShortIDs:         keys.ShortIDs,
		AgentVersion:     version,
	})
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}

	enrolled := config.Identity{
		NodeID:     cfg.NodeID,
		AgentToken: res.AgentToken,
		AgentEpoch: strconv.FormatInt(res.AgentEpoch, 10),
		EnrolledAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveIdentity(cfg.StateDir, enrolled); err != nil {
		return nil, fmt.Errorf("persist identity: %w", err)
	}
	cp.UseToken(res.AgentToken)
	cfg.BootstrapToken = "" // одноразовый: из памяти убираем сразу после обмена

	logger.Info("enrolled with control plane",
		"node_id", cfg.NodeID,
		"agent_epoch", enrolled.AgentEpoch,
		"identity_path", config.IdentityPath(cfg.StateDir))
	logger.Warn("bootstrap_token использован и больше не действует — удалите его из конфига агента")
	return &enrolled, nil
}

// agentEpochOrFallback guarantees a non-empty epoch for report_id uniqueness.
// Источник истины — эпоха, выданная control-plane при энроллменте: она растёт на
// каждую переналивку ноды, и report_id новой инкарнации не сталкиваются с уже
// принятыми. Значение из конфига и время старта — запасные варианты для нод,
// которые ещё не проходили энроллмент.
func agentEpochOrFallback(cfg *config.Config, ident *config.Identity) string {
	if ident != nil && ident.AgentEpoch != "" {
		return ident.AgentEpoch
	}
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
