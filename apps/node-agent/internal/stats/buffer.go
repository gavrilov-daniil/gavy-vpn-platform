// Package stats implements a durable, crash-safe buffer for Xray traffic counters.
//
// Durability invariant (why this package exists):
// counters are read from Xray with QueryStats(reset=true). That read is
// DESTRUCTIVE — Xray zeroes the counter as it hands back the value, so each read
// yields the delta since the previous read. The delta now exists nowhere but in
// this process. If we crash before it reaches durable storage, those bytes are
// lost forever (the counter is already zero in Xray). Therefore every appended
// delta must be persisted to disk before the read is considered complete, and it
// stays buffered until the control plane acks its report_id.
package stats

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Потолок буфера. Панель может лежать сутками, а места на ноде немного; снапшот
// к тому же переписывается ЦЕЛИКОМ каждый цикл, поэтому дорог не только объём, но
// и скорость его роста: без потолка буфер заполняет диск и делает каждый цикл
// дороже предыдущего.
//
// При переполнении выбрасываются САМЫЕ СТАРЫЕ записи: свежий трафик ценнее давнего,
// и очередь остаётся FIFO. Дропать свежие означало бы вечно упираться в ту же голову.
//
// Порядок величин: ~500 записей при 30-секундном цикле — это около 4 часов
// недоступности control-plane, файл при этом порядка нескольких мегабайт.
const (
	MaxPendingEntries  = 500
	MaxPendingCounters = 50_000
)

// Counter is a single named traffic counter (e.g.
// "user>>>alice@example.com>>>traffic>>>uplink") as returned by Xray's
// StatsService.QueryStats.
type Counter struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

// Entry is one durable report unit: the counters read in a single
// QueryStats(reset=true) call, tagged with a monotonic report_id so the control
// plane can dedup on redelivery.
//
// WindowStart — момент предыдущего чтения счётчиков. Дельта относится к окну
// [WindowStart, CollectedAt], и control-plane принимает её именно окном: вторым
// барьером дедупа у него служит UNIQUE(node, subject, window_start).
type Entry struct {
	ReportID    string    `json:"report_id"`
	WindowStart time.Time `json:"window_start"`
	CollectedAt time.Time `json:"collected_at"`
	Counters    []Counter `json:"counters"`
}

// bufferFile is the on-disk snapshot. HighWaterSeq is persisted separately from
// Pending so that seq is monotonic even after every buffered entry is acked and
// dropped: without it, a restart with an empty buffer would restart seq at 1 and
// reuse a report_id the control plane already processed.
type bufferFile struct {
	HighWaterSeq uint64  `json:"high_water_seq"`
	Pending      []Entry `json:"pending"`
}

// Buffer is a durable FIFO of unshipped stats entries.
//
// v1 status: SKELETON. The wiring (report_id assignment, ack-driven drop,
// restart recovery) is real; the persistence strategy is a whole-snapshot rewrite
// which is correct but not optimal.
// TODO(M2): switch to an append-only log + periodic compaction, and fsync the
// file and its parent dir before returning from Append (see durability invariant).
type Buffer struct {
	mu         sync.Mutex
	path       string
	agentEpoch string
	log        *slog.Logger
	seq        uint64
	pending    []Entry
}

// New opens (or creates) the buffer at path and recovers any unshipped entries.
func New(path, agentEpoch string, log *slog.Logger) (*Buffer, error) {
	if agentEpoch == "" {
		return nil, errors.New("stats: agent_epoch is required for report_id uniqueness")
	}
	if log == nil {
		log = slog.Default()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("stats: create dir: %w", err)
	}
	b := &Buffer{path: path, agentEpoch: agentEpoch, log: log}
	if err := b.recover(); err != nil {
		return nil, err
	}
	// Восстановленный буфер тоже подрезаем: потолок мог появиться (или снизиться)
	// уже после того, как файл разросся. Блокировка не нужна — буфер ещё ничей.
	b.trimLocked()
	return b, nil
}

// Append assigns the next report_id, durably persists the entry, and returns it.
// windowStart is when the previous destructive read happened — it bounds the
// window the appended deltas belong to.
// On persist failure the in-memory state is rolled back so the caller can retry;
// note the caller must NOT have discarded the source counters, since the Xray
// reset already happened.
func (b *Buffer) Append(windowStart time.Time, counters []Counter) (Entry, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.seq++
	e := Entry{
		ReportID:    fmt.Sprintf("%s:%d", b.agentEpoch, b.seq),
		WindowStart: windowStart.UTC(),
		CollectedAt: time.Now().UTC(),
		Counters:    counters,
	}
	before := b.pending
	b.pending = append(b.pending, e)
	b.trimLocked()
	if err := b.persistLocked(); err != nil {
		// Откат ровно в то состояние, что было до вызова: подрезка могла выбросить
		// старые записи, а на диск ничего не легло — иначе память и файл разошлись бы.
		b.pending = before
		b.seq--
		return Entry{}, fmt.Errorf("stats: persist entry: %w", err)
	}
	return e, nil
}

// trimLocked enforces the buffer ceiling by dropping the OLDEST entries.
// Caller must hold b.mu.
func (b *Buffer) trimLocked() {
	dropped, droppedCounters := 0, 0
	counters := 0
	for _, e := range b.pending {
		counters += len(e.Counters)
	}

	for len(b.pending) > MaxPendingEntries || (counters > MaxPendingCounters && len(b.pending) > 1) {
		counters -= len(b.pending[0].Counters)
		droppedCounters += len(b.pending[0].Counters)
		dropped++
		b.pending = b.pending[1:]
	}
	if dropped == 0 {
		return
	}
	// Прямая недостача в учёте трафика, а не рабочий режим: если это видно в логах
	// регулярно — control-plane недоступен слишком долго либо потолок мал для ноды.
	b.log.Error("stats: buffer overflow, oldest entries dropped",
		"dropped_entries", dropped,
		"dropped_counters", droppedCounters,
		"kept_entries", len(b.pending))
}

// Pending returns a copy of the currently unshipped entries.
func (b *Buffer) Pending() []Entry {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Entry, len(b.pending))
	copy(out, b.pending)
	return out
}

// MarkShipped drops every entry up to and including reportID (reports are
// monotonic, so an ack for seq N acks everything <= N). An ack for a different
// agent_epoch is ignored — it belongs to a previous incarnation.
func (b *Buffer) MarkShipped(reportID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	epoch, seq, ok := parseReportID(reportID)
	if !ok || epoch != b.agentEpoch {
		return nil
	}
	kept := make([]Entry, 0, len(b.pending))
	for _, e := range b.pending {
		if ep, es, ok := parseReportID(e.ReportID); ok && ep == b.agentEpoch && es <= seq {
			continue
		}
		kept = append(kept, e)
	}
	b.pending = kept
	return b.persistLocked()
}

func (b *Buffer) recover() error {
	raw, err := os.ReadFile(b.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stats: read buffer: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}
	var bf bufferFile
	if err := json.Unmarshal(raw, &bf); err != nil {
		// TODO(M2): quarantine a corrupt buffer instead of refusing to start.
		return fmt.Errorf("stats: parse buffer %s: %w", b.path, err)
	}
	b.seq = bf.HighWaterSeq
	b.pending = bf.Pending
	return nil
}

func (b *Buffer) persistLocked() error {
	raw, err := json.Marshal(bufferFile{HighWaterSeq: b.seq, Pending: b.pending})
	if err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	// TODO(M2): fsync tmp and the parent dir before rename for real crash safety.
	return os.Rename(tmp, b.path)
}

func parseReportID(id string) (epoch string, seq uint64, ok bool) {
	i := strings.LastIndex(id, ":")
	if i < 0 {
		return "", 0, false
	}
	s, err := strconv.ParseUint(id[i+1:], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return id[:i], s, true
}
