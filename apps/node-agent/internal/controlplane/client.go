// Package controlplane is the dial-out (PULL) mTLS client to the control plane.
//
// The agent always initiates the connection; the control plane never dials the
// node. This means a node only needs outbound 443 — no inbound management port,
// no public API surface on the node itself.
package controlplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"vpn-platform/node-agent/internal/stats"
)

// User is one Xray client. In v1 users are just a mirror of what is already in
// the full config; the field exists so the agent can log/report user counts and
// later (M2) apply user-only deltas without a restart.
type User struct {
	Email string `json:"email"`
	UUID  string `json:"uuid"`
	Level int    `json:"level"`
}

// DesiredState is the full, authoritative declaration for the node.
type DesiredState struct {
	Version    int64           `json:"version"`
	ConfigHash string          `json:"config_hash"` // sha256 of canonical config JSON
	Config     json.RawMessage `json:"config"`      // the entire Xray config for this node
	Users      []User          `json:"users"`
}

// signedEnvelope wraps the desired state. The signature covers Payload's exact
// bytes as received — signing raw bytes (not a re-serialized struct) sidesteps
// any JSON canonicalization mismatch between control plane and agent.
type signedEnvelope struct {
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"` // base64(RS256 over Payload)
}

type SysStats struct {
	Load1      float64 `json:"load1"`
	UptimeSec  float64 `json:"uptime_sec"`
	MemTotalKB uint64  `json:"mem_total_kb"`
	MemAvailKB uint64  `json:"mem_avail_kb"`
}

// ObservedState is what the agent reports back each cycle (heartbeat + result).
type ObservedState struct {
	NodeID         string
	AgentEpoch     string
	AgentVersion   string
	AppliedHash    string
	AppliedVersion int64
	XrayVersion    string
	Sys            SysStats
	Stats          []stats.Entry
}

// ReportAck tells the agent which stats report_id the control plane durably
// accepted; the buffer drops everything up to it.
type ReportAck struct {
	AckedReportID string `json:"acked_report_id"`
}

// RegisterResult is returned by the one-time bootstrap handshake.
type RegisterResult struct {
	NodeID     string `json:"node_id"`
	AgentEpoch string `json:"agent_epoch"`
	// TODO: the control plane issues the mTLS client certificate here in exchange
	// for the one-time bootstrap token; the agent persists it and uses it for all
	// subsequent (mTLS) calls.
}

type Client struct {
	baseURL string
	httpc   *http.Client
	cpPub   *rsa.PublicKey
}

type Options struct {
	BaseURL         string
	ClientCertPath  string
	ClientKeyPath   string
	CPPublicKeyPath string
}

func New(opts Options) (*Client, error) {
	cert, err := tls.LoadX509KeyPair(opts.ClientCertPath, opts.ClientKeyPath)
	if err != nil {
		return nil, fmt.Errorf("controlplane: load client cert: %w", err)
	}
	pub, err := loadRSAPublicKey(opts.CPPublicKeyPath)
	if err != nil {
		return nil, err
	}
	httpc := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS13,
			},
			MaxIdleConns:        4,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
		},
	}
	return &Client{
		baseURL: strings.TrimRight(opts.BaseURL, "/"),
		httpc:   httpc,
		cpPub:   pub,
	}, nil
}

// VerifySignature verifies an RS256 (RSASSA-PKCS1-v1_5 + SHA-256) signature over
// payload. This is the agent's root of trust: even if the transport is somehow
// compromised, an attacker cannot forge a desired state without the control
// plane's private key.
func VerifySignature(payload []byte, signatureB64 string, pub *rsa.PublicKey) error {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureB64))
	if err != nil {
		return fmt.Errorf("controlplane: decode signature: %w", err)
	}
	sum := sha256.Sum256(payload)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return fmt.Errorf("controlplane: signature verification failed: %w", err)
	}
	return nil
}

// PullDesiredState fetches, verifies, and decodes the signed desired state.
func (c *Client) PullDesiredState(ctx context.Context) (*DesiredState, error) {
	body, err := c.do(ctx, http.MethodGet, "/v1/desired-state", nil, "")
	if err != nil {
		return nil, err
	}
	var env signedEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("controlplane: decode envelope: %w", err)
	}
	if err := VerifySignature(env.Payload, env.Signature, c.cpPub); err != nil {
		return nil, err
	}
	var ds DesiredState
	if err := json.Unmarshal(env.Payload, &ds); err != nil {
		return nil, fmt.Errorf("controlplane: decode desired state: %w", err)
	}
	return &ds, nil
}

// ReportState reports observed state (applied hash, versions, sys stats) plus any
// pending stats entries, and returns the ack.
func (c *Client) ReportState(ctx context.Context, obs ObservedState) (*ReportAck, error) {
	payload, err := json.Marshal(reportRequest{
		NodeID:         obs.NodeID,
		AgentEpoch:     obs.AgentEpoch,
		AgentVersion:   obs.AgentVersion,
		AppliedHash:    obs.AppliedHash,
		AppliedVersion: obs.AppliedVersion,
		XrayVersion:    obs.XrayVersion,
		Sys:            obs.Sys,
		Stats:          obs.Stats,
	})
	if err != nil {
		return nil, fmt.Errorf("controlplane: encode report: %w", err)
	}
	body, err := c.do(ctx, http.MethodPost, "/v1/report", payload, "")
	if err != nil {
		return nil, err
	}
	var ack ReportAck
	if len(body) > 0 {
		if err := json.Unmarshal(body, &ack); err != nil {
			return nil, fmt.Errorf("controlplane: decode report ack: %w", err)
		}
	}
	return &ack, nil
}

// Register performs the one-time bootstrap: it authenticates with a single-use
// token (not mTLS — the client cert may not exist yet) and hands the control
// plane the Reality PUBLIC key + shortIDs so it can build client-facing configs
// without ever seeing the private key.
func (c *Client) Register(ctx context.Context, bootstrapToken, realityPublicKey string, shortIDs []string) (*RegisterResult, error) {
	payload, err := json.Marshal(registerRequest{
		RealityPublicKey: realityPublicKey,
		RealityShortIDs:  shortIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("controlplane: encode register: %w", err)
	}
	body, err := c.do(ctx, http.MethodPost, "/v1/register", payload, "Bearer "+bootstrapToken)
	if err != nil {
		return nil, err
	}
	var res RegisterResult
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, fmt.Errorf("controlplane: decode register result: %w", err)
	}
	return &res, nil
}

type reportRequest struct {
	NodeID         string        `json:"node_id"`
	AgentEpoch     string        `json:"agent_epoch"`
	AgentVersion   string        `json:"agent_version"`
	AppliedHash    string        `json:"applied_hash"`
	AppliedVersion int64         `json:"applied_version"`
	XrayVersion    string        `json:"xray_version"`
	Sys            SysStats      `json:"sys"`
	Stats          []stats.Entry `json:"stats"`
}

type registerRequest struct {
	RealityPublicKey string   `json:"reality_public_key"`
	RealityShortIDs  []string `json:"reality_short_ids"`
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, authorization string) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return nil, fmt.Errorf("controlplane: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}

	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("controlplane: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("controlplane: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("controlplane: %s %s: status %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return respBody, nil
}

func loadRSAPublicKey(path string) (*rsa.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("controlplane: read cp public key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("controlplane: cp public key %s is not PEM", path)
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("controlplane: parse cp public key: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("controlplane: cp public key is not RSA")
	}
	return rsaPub, nil
}
