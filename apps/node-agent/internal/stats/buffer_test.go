package stats

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newBuffer(t *testing.T) *Buffer {
	t.Helper()
	b, err := New(filepath.Join(t.TempDir(), "stats-buffer.json"), "7", quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b
}

func TestAppendAssignsMonotonicReportIDs(t *testing.T) {
	b := newBuffer(t)
	first, err := b.Append(time.Now(), []Counter{{Name: "a", Value: 1}})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	second, err := b.Append(time.Now(), []Counter{{Name: "b", Value: 2}})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if first.ReportID != "7:1" || second.ReportID != "7:2" {
		t.Fatalf("report ids = %q, %q; want 7:1, 7:2", first.ReportID, second.ReportID)
	}
}

// Потолок буфера: без него недоступный сутки control-plane заполняет диск ноды,
// а снапшот, переписываемый целиком каждый цикл, дорожает с каждой записью.
func TestAppendDropsOldestPastEntryCeiling(t *testing.T) {
	b := newBuffer(t)
	total := MaxPendingEntries + 10
	for i := 0; i < total; i++ {
		if _, err := b.Append(time.Now(), []Counter{{Name: "a", Value: 1}}); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}

	pending := b.Pending()
	if len(pending) != MaxPendingEntries {
		t.Fatalf("pending = %d; want %d", len(pending), MaxPendingEntries)
	}
	// Выброшены должны быть САМЫЕ СТАРЫЕ: свежий трафик ценнее давнего.
	if got, want := pending[0].ReportID, "7:11"; got != want {
		t.Fatalf("oldest kept = %q; want %q", got, want)
	}
	if got, want := pending[len(pending)-1].ReportID, "7:510"; got != want {
		t.Fatalf("newest kept = %q; want %q", got, want)
	}
}

func TestAppendDropsOldestPastCounterCeiling(t *testing.T) {
	b := newBuffer(t)
	chunk := make([]Counter, MaxPendingCounters/4)
	for i := range chunk {
		chunk[i] = Counter{Name: "user>>>x>>>traffic>>>uplink", Value: 1}
	}

	for i := 0; i < 10; i++ {
		if _, err := b.Append(time.Now(), chunk); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}

	counters := 0
	for _, e := range b.Pending() {
		counters += len(e.Counters)
	}
	if counters > MaxPendingCounters {
		t.Fatalf("buffered counters = %d; want <= %d", counters, MaxPendingCounters)
	}
	if len(b.Pending()) == 0 {
		t.Fatal("buffer emptied itself; the newest entry must survive")
	}
}

// Единственная запись крупнее потолка не выбрасывается: резать её здесь нечем,
// а пустой буфер означал бы гарантированную потерю вместо возможной.
func TestAppendKeepsSingleOversizedEntry(t *testing.T) {
	b := newBuffer(t)
	huge := make([]Counter, MaxPendingCounters+1)
	if _, err := b.Append(time.Now(), huge); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if len(b.Pending()) != 1 {
		t.Fatalf("pending = %d; want 1", len(b.Pending()))
	}
}

func TestMarkShippedDropsEverythingUpToSeq(t *testing.T) {
	b := newBuffer(t)
	for i := 0; i < 3; i++ {
		if _, err := b.Append(time.Now(), []Counter{{Name: "a", Value: 1}}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	if err := b.MarkShipped("7:2"); err != nil {
		t.Fatalf("MarkShipped: %v", err)
	}
	pending := b.Pending()
	if len(pending) != 1 || pending[0].ReportID != "7:3" {
		t.Fatalf("pending = %+v; want only 7:3", pending)
	}
}

// Восстановление после рестарта: seq не переиспользуется, иначе control-plane
// принял бы новую дельту за уже обработанный батч и молча её отбросил.
func TestRecoverKeepsSeqMonotonicAfterRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stats-buffer.json")

	first, err := New(path, "7", quietLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := first.Append(time.Now(), []Counter{{Name: "a", Value: 1}}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := first.MarkShipped("7:1"); err != nil {
		t.Fatalf("MarkShipped: %v", err)
	}

	second, err := New(path, "7", quietLogger())
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	entry, err := second.Append(time.Now(), []Counter{{Name: "b", Value: 1}})
	if err != nil {
		t.Fatalf("Append after restart: %v", err)
	}
	if entry.ReportID != "7:2" {
		t.Fatalf("report id after restart = %q; want 7:2", entry.ReportID)
	}
}
