package controlplane

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(t *testing.T, baseURL string, opts ...func(*Options)) *Client {
	t.Helper()
	o := Options{BaseURL: baseURL, NodeID: "node-1"}
	for _, fn := range opts {
		fn(&o)
	}
	c, err := New(o)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestEnrollSendsBootstrapWithoutAgentToken(t *testing.T) {
	var gotPath, gotAgentHeader string
	var gotBody EnrollRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAgentHeader = r.Header.Get("x-agent-token")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(EnrollResponse{NodeID: "node-1", AgentToken: "per-node-token", AgentEpoch: 4})
	}))
	defer srv.Close()

	c := newTestClient(t, srv.URL)
	res, err := c.Enroll(context.Background(), EnrollRequest{
		NodeID:           "node-1",
		BootstrapToken:   "bootstrap-1",
		RealityPublicKey: "PUB",
		ShortIDs:         []string{"aabb"},
	})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}

	if gotPath != "/internal/agent/enroll" {
		t.Errorf("path = %q", gotPath)
	}
	// Токена у ноды ещё нет: пустой заголовок не должен уезжать вовсе.
	if gotAgentHeader != "" {
		t.Errorf("x-agent-token = %q, want empty", gotAgentHeader)
	}
	if gotBody.BootstrapToken != "bootstrap-1" || gotBody.RealityPublicKey != "PUB" || len(gotBody.ShortIDs) != 1 {
		t.Errorf("body = %+v", gotBody)
	}
	if res.AgentToken != "per-node-token" || res.AgentEpoch != 4 {
		t.Errorf("res = %+v", res)
	}

	c.UseToken(res.AgentToken)
	if c.token != "per-node-token" {
		t.Errorf("token after UseToken = %q", c.token)
	}
}

func TestEnrollRejectsEmptyBootstrapToken(t *testing.T) {
	c := newTestClient(t, "https://cp.invalid")
	if _, err := c.Enroll(context.Background(), EnrollRequest{NodeID: "node-1"}); err == nil {
		t.Fatal("enroll без bootstrap-токена должен падать до запроса")
	}
}

func TestEnrollRejectsResponseWithoutToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"nodeId":"node-1"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv.URL)
	if _, err := c.Enroll(context.Background(), EnrollRequest{NodeID: "node-1", BootstrapToken: "b"}); err == nil {
		t.Fatal("ответ без agentToken должен быть ошибкой, а не пустым токеном")
	}
}

// Подпись desired-state: конверт принимается, а снятие подписи при заданном
// ключе — нет (иначе защита снималась бы удалением поля).
func TestUnwrapEnvelopeAndDowngrade(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	payload := []byte(`{"version":1,"configHash":"abc"}`)
	sum := sha256.Sum256(payload)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	envelope, err := json.Marshal(signedEnvelope{Payload: payload, Signature: base64.StdEncoding.EncodeToString(sig)})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	pinned := &Client{cpPub: &key.PublicKey}
	got, err := pinned.unwrap(envelope)
	if err != nil {
		t.Fatalf("unwrap signed: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("payload = %s", got)
	}

	if _, err := pinned.unwrap(payload); err == nil {
		t.Error("ключ задан, подписи нет — должно быть ошибкой (даунгрейд)")
	}

	unpinned := &Client{}
	if _, err := unpinned.unwrap(envelope); err == nil {
		t.Error("конверт без ключа — проверять нечем, должно быть ошибкой")
	}
	if _, err := unpinned.unwrap(payload); err != nil {
		t.Errorf("голый JSON без ключа должен приниматься: %v", err)
	}
}
