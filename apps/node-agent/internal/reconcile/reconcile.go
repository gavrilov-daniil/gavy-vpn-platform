// Package reconcile runs the pull → verify → apply → report loop.
package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"vpn-platform/node-agent/internal/config"
	"vpn-platform/node-agent/internal/controlplane"
	"vpn-platform/node-agent/internal/stats"
	"vpn-platform/node-agent/internal/xray"
)

type Reconciler struct {
	cfg          *config.Config
	cp           *controlplane.Client
	xray         *xray.Manager
	stats        *stats.Buffer
	log          *slog.Logger
	agentVersion string
	statePath    string
}

func New(cfg *config.Config, cp *controlplane.Client, xr *xray.Manager, sb *stats.Buffer, log *slog.Logger, agentVersion string) *Reconciler {
	return &Reconciler{
		cfg:          cfg,
		cp:           cp,
		xray:         xr,
		stats:        sb,
		log:          log,
		agentVersion: agentVersion,
		statePath:    filepath.Join(cfg.StateDir, "applied-state.json"),
	}
}

// Run reconciles once immediately, then on every tick until ctx is cancelled.
// A failed pass is logged and swallowed: if the control plane is unreachable the
// node must keep serving its last applied config, not fall over.
func (r *Reconciler) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.cfg.PullInterval)
	defer ticker.Stop()

	if err := r.reconcileOnce(ctx); err != nil {
		r.log.Warn("reconcile: initial pass failed, keeping last applied config", "err", err)
	}

	for {
		select {
		case <-ctx.Done():
			r.log.Info("reconcile: shutting down")
			return ctx.Err()
		case <-ticker.C:
			if err := r.reconcileOnce(ctx); err != nil {
				r.log.Warn("reconcile: pass failed, keeping last applied config", "err", err)
			}
		}
	}
}

func (r *Reconciler) reconcileOnce(ctx context.Context) error {
	desired, err := r.cp.PullDesiredState(ctx)
	if err != nil {
		return fmt.Errorf("pull: %w", err)
	}

	applied, err := r.loadAppliedState()
	if err != nil {
		return fmt.Errorf("load applied state: %w", err)
	}

	// Hash idempotency: identical config_hash means nothing to do.
	if desired.ConfigHash == applied.ConfigHash {
		r.log.Debug("reconcile: config unchanged", "config_hash", desired.ConfigHash, "version", desired.Version)
	} else {
		r.log.Info("reconcile: applying new config",
			"from_hash", applied.ConfigHash,
			"to_hash", desired.ConfigHash,
			"version", desired.Version,
			"users", len(desired.Users))
		if err := r.apply(ctx, desired); err != nil {
			return fmt.Errorf("apply: %w", err)
		}
		applied = appliedState{
			ConfigHash: desired.ConfigHash,
			Version:    desired.Version,
			AppliedAt:  time.Now().UTC(),
		}
		if err := r.saveAppliedState(applied); err != nil {
			return fmt.Errorf("persist applied state: %w", err)
		}
	}

	if err := r.report(ctx, applied); err != nil {
		return fmt.Errorf("report: %w", err)
	}
	if err := r.shipStats(ctx); err != nil {
		return fmt.Errorf("ship stats: %w", err)
	}
	return nil
}

func (r *Reconciler) apply(ctx context.Context, ds *controlplane.DesiredState) error {
	if err := r.xray.WriteConfig(r.cfg.XrayConfigPath, ds.Config); err != nil {
		return err
	}
	// v1 is thin: users live inside the full config, so any change (including a
	// single added/removed user) is applied by rewriting the config and doing a
	// full restart.
	// TODO(M2): apply user-only deltas live via Xray gRPC HandlerService.AlterInbound
	// (add/remove clients without dropping connections), and only reload/restart
	// when non-user parts of the config actually change.
	if err := r.xray.Restart(ctx); err != nil {
		return err
	}
	return nil
}

func (r *Reconciler) report(ctx context.Context, applied appliedState) error {
	xrayVer, err := r.xray.Version(ctx)
	if err != nil {
		r.log.Warn("reconcile: xray version unavailable", "err", err)
		xrayVer = ""
	}

	return r.cp.ReportState(ctx, controlplane.ObservedState{
		AppliedConfigHash: applied.ConfigHash,
		AgentVersion:      r.agentVersion,
		XrayVersion:       xrayVer,
		Sys:               collectSysStats(),
	})
}

// shipStats ships the buffered stats batches one by one — each carries its own
// report_id, which is what the control plane dedups on.
//
// TODO(M2): read counters via xray.Stats (QueryStats reset=true) and
// r.stats.Append them before shipping. For now we only ship whatever is already
// buffered (normally nothing in v1).
func (r *Reconciler) shipStats(ctx context.Context) error {
	for _, entry := range r.stats.Pending() {
		accepted, err := r.cp.ShipStats(ctx, controlplane.BatchFromEntry(entry))
		if err != nil {
			return err
		}
		// accepted=false — батч уже принят control-plane раньше. Ретрай даст тот же
		// ответ, поэтому дропаем буфер точно так же, как при accepted=true.
		if !accepted {
			r.log.Warn("reconcile: stats batch already accepted, dropping", "report_id", entry.ReportID)
		}
		if err := r.stats.MarkShipped(entry.ReportID); err != nil {
			return fmt.Errorf("mark shipped %s: %w", entry.ReportID, err)
		}
	}
	return nil
}

// appliedState persists what we last successfully applied, so a restart with an
// unchanged desired state is a no-op rather than a needless Xray restart.
type appliedState struct {
	ConfigHash string    `json:"config_hash"`
	Version    int64     `json:"version"`
	AppliedAt  time.Time `json:"applied_at"`
}

func (r *Reconciler) loadAppliedState() (appliedState, error) {
	raw, err := os.ReadFile(r.statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return appliedState{}, nil
		}
		return appliedState{}, err
	}
	var st appliedState
	if err := json.Unmarshal(raw, &st); err != nil {
		return appliedState{}, fmt.Errorf("corrupt applied state %s: %w", r.statePath, err)
	}
	return st, nil
}

func (r *Reconciler) saveAppliedState(st appliedState) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o750); err != nil {
		return err
	}
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.statePath)
}

// collectSysStats reads a few cheap health signals from /proc (Linux). Best
// effort: any missing file just leaves the zero value.
func collectSysStats() controlplane.SysStats {
	var s controlplane.SysStats
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if f := strings.Fields(string(raw)); len(f) > 0 {
			if v, err := strconv.ParseFloat(f[0], 64); err == nil {
				s.Load1 = v
			}
		}
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(raw)); len(f) > 0 {
			if v, err := strconv.ParseFloat(f[0], 64); err == nil {
				s.UptimeSec = v
			}
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			switch f[0] {
			case "MemTotal:":
				if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
					s.MemTotalKB = v
				}
			case "MemAvailable:":
				if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
					s.MemAvailKB = v
				}
			}
		}
	}
	return s
}
