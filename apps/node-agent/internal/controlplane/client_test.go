package controlplane

import (
	"testing"
	"time"

	"vpn-platform/node-agent/internal/stats"
)

func TestParseCounterName(t *testing.T) {
	tests := []struct {
		name      string
		in        string
		typ       string
		key       string
		direction string
		ok        bool
	}{
		{"user uplink", "user>>>foo@bar>>>traffic>>>uplink", "user", "foo@bar", "uplink", true},
		{"user downlink", "user>>>alice@example.com>>>traffic>>>downlink", "user", "alice@example.com", "downlink", true},
		{"inbound", "inbound>>>vless-in>>>traffic>>>uplink", "inbound", "vless-in", "uplink", true},
		{"outbound", "outbound>>>freedom>>>traffic>>>downlink", "outbound", "freedom", "downlink", true},

		// email как ключ — произвольная строка, в том числе с точками и плюсом
		{"plus addressing", "user>>>a+b@c.dev>>>traffic>>>uplink", "user", "a+b@c.dev", "uplink", true},
		{"empty key", "user>>>>>>traffic>>>uplink", "user", "", "uplink", true},

		// мусор
		{"empty", "", "", "", "", false},
		{"no separators", "user", "", "", "", false},
		{"too few parts", "user>>>foo@bar>>>uplink", "", "", "", false},
		{"too many parts", "user>>>foo@bar>>>traffic>>>uplink>>>extra", "", "", "", false},
		{"unknown subject", "session>>>foo>>>traffic>>>uplink", "", "", "", false},
		{"unknown middle", "user>>>foo>>>online>>>uplink", "", "", "", false},
		{"unknown direction", "user>>>foo>>>traffic>>>sideways", "", "", "", false},
		{"wrong separator", "user>>foo>>traffic>>uplink", "", "", "", false},
		{"case sensitive subject", "User>>>foo>>>traffic>>>uplink", "", "", "", false},
		{"case sensitive direction", "user>>>foo>>>traffic>>>Uplink", "", "", "", false},
		{"sys counter", "inbound>>>api>>>traffic", "", "", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			typ, key, direction, ok := parseCounterName(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (input %q)", ok, tc.ok, tc.in)
			}
			if !ok {
				return
			}
			if typ != tc.typ || key != tc.key || direction != tc.direction {
				t.Errorf("got {%q %q %q}, want {%q %q %q}", typ, key, direction, tc.typ, tc.key, tc.direction)
			}
		})
	}
}

func TestBatchFromEntryAggregatesBySubject(t *testing.T) {
	start := time.Date(2026, 7, 26, 10, 0, 0, 0, time.UTC)
	end := start.Add(30 * time.Second)

	entry := stats.Entry{
		ReportID:    "epoch-1:7",
		WindowStart: start,
		CollectedAt: end,
		Counters: []stats.Counter{
			{Name: "user>>>alice@example.com>>>traffic>>>uplink", Value: 100},
			{Name: "user>>>alice@example.com>>>traffic>>>downlink", Value: 900},
			{Name: "garbage", Value: 12345},
			{Name: "inbound>>>vless-in>>>traffic>>>uplink", Value: 7},
			// Xray может отдать один и тот же счётчик дважды — суммируем, не затираем.
			{Name: "user>>>alice@example.com>>>traffic>>>uplink", Value: 5},
		},
	}

	batch := BatchFromEntry(entry)

	if batch.ReportID != "epoch-1:7" {
		t.Errorf("reportId = %q", batch.ReportID)
	}
	if len(batch.Deltas) != 2 {
		t.Fatalf("got %d deltas, want 2 (мусорный счётчик должен быть отброшен): %+v", len(batch.Deltas), batch.Deltas)
	}

	alice := batch.Deltas[0]
	if alice.SubjectType != "user" || alice.SubjectKey != "alice@example.com" {
		t.Errorf("delta[0] subject = %s/%s", alice.SubjectType, alice.SubjectKey)
	}
	if alice.UpDelta != 105 || alice.DownDelta != 900 {
		t.Errorf("delta[0] = up %d / down %d, want 105/900", alice.UpDelta, alice.DownDelta)
	}
	if alice.WindowStart != start.Format(time.RFC3339Nano) || alice.WindowEnd != end.Format(time.RFC3339Nano) {
		t.Errorf("delta[0] window = %s..%s", alice.WindowStart, alice.WindowEnd)
	}

	in := batch.Deltas[1]
	if in.SubjectType != "inbound" || in.SubjectKey != "vless-in" || in.UpDelta != 7 || in.DownDelta != 0 {
		t.Errorf("delta[1] = %+v", in)
	}
}

// Пустой батч должен ехать с deltas: [], а не null — на той стороне это разбор
// массива, и null уронил бы приём отчёта.
func TestBatchFromEntryNeverNilDeltas(t *testing.T) {
	batch := BatchFromEntry(stats.Entry{ReportID: "e:1"})
	if batch.Deltas == nil {
		return // ShipStats подставит пустой срез
	}
	if len(batch.Deltas) != 0 {
		t.Errorf("got %d deltas, want 0", len(batch.Deltas))
	}
}
