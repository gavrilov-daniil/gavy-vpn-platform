package xray

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vpn-platform/node-agent/internal/stats"
)

// fakeStatsServer поднимает h2c-сервер, говорящий по gRPC-протоколу так же, как
// Xray: length-prefixed кадр в теле, статус в трейлере. Живого Xray в тестах
// нет, а самая хрупкая часть клиента — именно транспорт (h2c, кадры, трейлеры),
// поэтому проверяем её целиком, а не только кодек.
func fakeStatsServer(t *testing.T, handler http.HandlerFunc) *statsClient {
	t.Helper()

	srv := httptest.NewUnstartedServer(handler)
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	srv.Config.Protocols = &protocols
	srv.Start()
	t.Cleanup(srv.Close)

	return newStatsClient(strings.TrimPrefix(srv.URL, "http://"))
}

// writeGrpcResponse отвечает как grpc-go: заголовки, кадр, трейлер со статусом.
func writeGrpcResponse(w http.ResponseWriter, msg []byte, status, message string) {
	w.Header().Set("Content-Type", "application/grpc")
	w.Header().Set("Trailer", "Grpc-Status, Grpc-Message")
	w.WriteHeader(http.StatusOK)
	if msg != nil {
		_, _ = w.Write(encodeFrame(msg))
	}
	w.Header().Set("Grpc-Status", status)
	w.Header().Set("Grpc-Message", message)
}

func encodeStat(name string, value int64) []byte {
	var b []byte
	b = appendVarint(b, fieldKey(1, wireBytes))
	b = appendVarint(b, uint64(len(name)))
	b = append(b, name...)
	b = appendVarint(b, fieldKey(2, wireVarint))
	b = appendVarint(b, uint64(value))
	return b
}

func encodeQueryStatsResponse(counters []stats.Counter) []byte {
	var b []byte
	for _, c := range counters {
		stat := encodeStat(c.Name, c.Value)
		b = appendVarint(b, fieldKey(1, wireBytes))
		b = appendVarint(b, uint64(len(stat)))
		b = append(b, stat...)
	}
	return b
}

func TestQueryStatsRoundTrip(t *testing.T) {
	want := []stats.Counter{
		{Name: "user>>>alice@example.com>>>traffic>>>uplink", Value: 1024},
		{Name: "user>>>alice@example.com>>>traffic>>>downlink", Value: 4096},
		{Name: "inbound>>>vless-in>>>traffic>>>uplink", Value: 1 << 40},
		{Name: "outbound>>>freedom>>>traffic>>>downlink", Value: 0},
	}

	var gotPath, gotContentType, gotTE string
	var gotBody []byte

	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotContentType = r.Header.Get("Content-Type")
		gotTE = r.Header.Get("Te")
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		gotBody = buf[:n]
		writeGrpcResponse(w, encodeQueryStatsResponse(want), "0", "")
	})

	got, err := client.QueryStats(context.Background(), "", true)
	if err != nil {
		t.Fatalf("QueryStats: %v", err)
	}

	if gotPath != queryStatsMethod {
		t.Errorf("path = %q, want %q", gotPath, queryStatsMethod)
	}
	if gotContentType != "application/grpc+proto" {
		t.Errorf("content-type = %q", gotContentType)
	}
	if gotTE != "trailers" {
		t.Errorf("te = %q, want trailers", gotTE)
	}

	// pattern="" опускается (дефолт proto3), reset=true → поле 2 varint 1.
	wantBody := encodeFrame([]byte{0x10, 0x01})
	if string(gotBody) != string(wantBody) {
		t.Errorf("request body = % x, want % x", gotBody, wantBody)
	}

	if len(got) != len(want) {
		t.Fatalf("got %d counters, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("counter[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestQueryStatsSendsPatternWhenSet(t *testing.T) {
	var gotBody []byte
	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		gotBody = buf[:n]
		writeGrpcResponse(w, []byte{}, "0", "")
	})

	if _, err := client.QueryStats(context.Background(), "user>>>", false); err != nil {
		t.Fatalf("QueryStats: %v", err)
	}

	want := encodeFrame(append([]byte{0x0A, 0x07}, "user>>>"...))
	if string(gotBody) != string(want) {
		t.Errorf("request body = % x, want % x", gotBody, want)
	}
}

func TestQueryStatsEmptyResponse(t *testing.T) {
	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeGrpcResponse(w, []byte{}, "0", "")
	})

	got, err := client.QueryStats(context.Background(), "", true)
	if err != nil {
		t.Fatalf("QueryStats: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d counters, want 0", len(got))
	}
}

func TestQueryStatsGrpcErrorInTrailer(t *testing.T) {
	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeGrpcResponse(w, nil, "12", "unknown service")
	})

	_, err := client.QueryStats(context.Background(), "", true)
	if err == nil {
		t.Fatal("want error on grpc-status 12, got nil")
	}
	if !strings.Contains(err.Error(), "unknown service") {
		t.Errorf("error = %v, want it to carry the grpc message", err)
	}
}

// Trailers-Only: grpc-go отвечает так, когда метод не найден — статус приезжает
// в заголовках, тела нет вовсе.
func TestQueryStatsTrailersOnlyError(t *testing.T) {
	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Grpc-Status", "5")
		w.Header().Set("Grpc-Message", "not found")
		w.WriteHeader(http.StatusOK)
	})

	if _, err := client.QueryStats(context.Background(), "", true); err == nil {
		t.Fatal("want error on trailers-only grpc-status 5, got nil")
	}
}

func TestQueryStatsHTTPError(t *testing.T) {
	client := fakeStatsServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})

	if _, err := client.QueryStats(context.Background(), "", true); err == nil {
		t.Fatal("want error on HTTP 502, got nil")
	}
}

// Xray дополняет схему между версиями (в QueryStatsRequest так появились
// patterns=3 и regexp=4). Неизвестные поля обязаны игнорироваться, иначе
// обновление Xray на ноде молча остановит учёт трафика.
func TestDecodeSkipsUnknownFields(t *testing.T) {
	stat := encodeStat("user>>>bob@example.com>>>traffic>>>uplink", 777)
	stat = appendVarint(stat, fieldKey(7, wireVarint)) // неизвестное varint-поле
	stat = appendVarint(stat, 42)
	stat = appendVarint(stat, fieldKey(8, wireBytes)) // неизвестное bytes-поле
	stat = appendVarint(stat, 3)
	stat = append(stat, "xyz"...)
	stat = appendVarint(stat, fieldKey(9, wireFixed32))
	stat = binary.LittleEndian.AppendUint32(stat, 1)
	stat = appendVarint(stat, fieldKey(10, wireFixed64))
	stat = binary.LittleEndian.AppendUint64(stat, 1)

	var msg []byte
	msg = appendVarint(msg, fieldKey(1, wireBytes))
	msg = appendVarint(msg, uint64(len(stat)))
	msg = append(msg, stat...)
	// И неизвестное поле на верхнем уровне сообщения.
	msg = appendVarint(msg, fieldKey(5, wireVarint))
	msg = appendVarint(msg, 1)

	got, err := decodeQueryStatsResponse(msg)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := stats.Counter{Name: "user>>>bob@example.com>>>traffic>>>uplink", Value: 777}
	if len(got) != 1 || got[0] != want {
		t.Errorf("got %+v, want [%+v]", got, want)
	}
}

func TestDecodeRejectsMalformedMessages(t *testing.T) {
	tests := []struct {
		name string
		msg  []byte
	}{
		{"length exceeds buffer", []byte{0x0A, 0x7F, 0x01}},
		{"truncated key", []byte{0xFF}},
		{"deprecated group wire type", []byte{byte(fieldKey(1, 3))}},
		{"truncated fixed32", []byte{byte(fieldKey(1, wireFixed32)), 0x01}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeQueryStatsResponse(tc.msg); err == nil {
				t.Errorf("want error for %q, got nil", tc.name)
			}
		})
	}
}

func TestDecodeFrame(t *testing.T) {
	if _, err := decodeFrame([]byte{0x00, 0x00}); err == nil {
		t.Error("want error on truncated frame header")
	}
	if _, err := decodeFrame([]byte{0x01, 0x00, 0x00, 0x00, 0x00}); err == nil {
		t.Error("want error on compressed frame")
	}
	if _, err := decodeFrame([]byte{0x00, 0x00, 0x00, 0x00, 0x10}); err == nil {
		t.Error("want error when declared length exceeds payload")
	}
	body, err := decodeFrame(encodeFrame([]byte{0x10, 0x01}))
	if err != nil {
		t.Fatalf("decodeFrame: %v", err)
	}
	if string(body) != string([]byte{0x10, 0x01}) {
		t.Errorf("body = % x", body)
	}
}

func TestStatsDisabledWithoutAPIAddr(t *testing.T) {
	m := NewManager("xray.service", "/tmp/reality.key", "")
	if _, err := m.Stats(context.Background()); err == nil {
		t.Fatal("want error when xray_api_addr is empty, got nil")
	}
}
