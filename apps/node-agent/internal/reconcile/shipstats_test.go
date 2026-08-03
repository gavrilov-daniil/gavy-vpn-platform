package reconcile

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vpn-platform/node-agent/internal/controlplane"
	"vpn-platform/node-agent/internal/stats"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// shipper собирает минимальный Reconciler: shipStats трогает только буфер,
// клиент control-plane и логгер, так что Xray и конфиг ему не нужны.
func shipper(t *testing.T, url string, entries int) (*Reconciler, *stats.Buffer) {
	t.Helper()

	buf, err := stats.New(filepath.Join(t.TempDir(), "stats-buffer.json"), "3", quietLogger())
	if err != nil {
		t.Fatalf("stats.New: %v", err)
	}
	for i := 0; i < entries; i++ {
		if _, err := buf.Append(time.Now(), []stats.Counter{
			{Name: "user>>>su-1>>>traffic>>>uplink", Value: 10},
		}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	cp, err := controlplane.New(controlplane.Options{
		BaseURL:    url,
		NodeID:     "11111111-1111-1111-1111-111111111111",
		AgentToken: "token",
	})
	if err != nil {
		t.Fatalf("controlplane.New: %v", err)
	}
	return &Reconciler{cp: cp, stats: buf, log: quietLogger()}, buf
}

func statsServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// 413 на батче — тот самый сценарий, из-за которого учёт трафика по ноде вставал
// НАСОВСЕМ: очередь строго FIFO, и не выброшенная голова блокирует всё остальное.
func TestShipStatsDropsPermanentlyRejectedBatch(t *testing.T) {
	var calls atomic.Int32
	srv := statsServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "request entity too large", http.StatusRequestEntityTooLarge)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true,"applied":1}`))
	})

	rec, buf := shipper(t, srv.URL, 2)
	if err := rec.shipStats(context.Background()); err != nil {
		t.Fatalf("shipStats: %v", err)
	}

	if pending := buf.Pending(); len(pending) != 0 {
		t.Fatalf("pending = %+v; отвергнутый навсегда батч обязан быть выброшен, очередь — продолжиться", pending)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("calls = %d; want 2 (второй батч должен был поехать следом)", got)
	}
}

// 5xx и сеть — временный отказ: буфер держим, повторяем на следующем цикле.
func TestShipStatsKeepsBufferOnServerError(t *testing.T) {
	srv := statsServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})

	rec, buf := shipper(t, srv.URL, 2)
	if err := rec.shipStats(context.Background()); err == nil {
		t.Fatal("shipStats вернул nil; временный отказ обязан всплыть наверх")
	}
	if pending := buf.Pending(); len(pending) != 2 {
		t.Fatalf("pending = %d; want 2 — данные не выбрасываются из-за 5xx", len(pending))
	}
}

// 401 формально 4xx, но чинится перевыпуском токена. Выбросить статистику здесь
// значит потерять её навсегда ради ошибки, которая пройдёт сама.
func TestShipStatsKeepsBufferOnUnauthorized(t *testing.T) {
	srv := statsServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})

	rec, buf := shipper(t, srv.URL, 1)
	if err := rec.shipStats(context.Background()); err == nil {
		t.Fatal("shipStats вернул nil; 401 обязан всплыть наверх")
	}
	if pending := buf.Pending(); len(pending) != 1 {
		t.Fatalf("pending = %d; want 1", len(pending))
	}
}

// accepted=false — control-plane уже принимал этот report_id. Повтор даст тот же
// ответ вечно, поэтому запись дропается так же, как при accepted=true.
func TestShipStatsDropsAlreadyAcceptedBatch(t *testing.T) {
	srv := statsServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":false,"applied":0}`))
	})

	rec, buf := shipper(t, srv.URL, 1)
	if err := rec.shipStats(context.Background()); err != nil {
		t.Fatalf("shipStats: %v", err)
	}
	if pending := buf.Pending(); len(pending) != 0 {
		t.Fatalf("pending = %d; want 0", len(pending))
	}
}
