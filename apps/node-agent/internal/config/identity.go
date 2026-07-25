package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// identityFile — имя файла с выданной сервером идентичностью ноды внутри state_dir.
const identityFile = "identity.json"

// Identity is what the control plane handed this node at enrollment. It lives in
// state_dir rather than in the config file: the config is what the operator rolls
// out, the identity is what the server issues, and mixing them means a re-deploy
// of the config silently reverts the node to a stale (or shared) credential.
//
// AgentToken — per-node секрет: токен одной ноды не открывает desired-state другой.
// Файл пишется с правами 0600 — в нём лежит секрет в открытом виде.
type Identity struct {
	NodeID     string `json:"node_id"`
	AgentToken string `json:"agent_token"`
	// AgentEpoch namespaces stats report_ids; the control plane bumps it on every
	// enrollment so a re-imaged node never reuses a previous incarnation's ids.
	AgentEpoch string `json:"agent_epoch"`
	EnrolledAt string `json:"enrolled_at"`
}

// IdentityPath returns where the identity is persisted for a given state dir.
func IdentityPath(stateDir string) string {
	return filepath.Join(stateDir, identityFile)
}

// LoadIdentity reads the persisted identity. A missing file is not an error: it
// just means this node has not enrolled yet.
func LoadIdentity(stateDir string) (*Identity, error) {
	path := IdentityPath(stateDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read identity %s: %w", path, err)
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		// Не «начинаем с чистого листа»: битый файл при живом bootstrap-токене
		// привёл бы к повторному энроллменту, а токен одноразовый — нода встала бы
		// совсем. Пусть оператор решает.
		return nil, fmt.Errorf("corrupt identity %s: %w", path, err)
	}
	return &id, nil
}

// SaveIdentity persists the identity atomically with 0600 permissions.
func SaveIdentity(stateDir string, id Identity) error {
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return fmt.Errorf("encode identity: %w", err)
	}
	if err := os.MkdirAll(stateDir, 0o750); err != nil {
		return fmt.Errorf("create state dir %s: %w", stateDir, err)
	}
	path := IdentityPath(stateDir)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	// WriteFile применяет права только при создании файла: уцелевший от прошлого
	// прогона .tmp сохранил бы свои, и секрет мог бы оказаться читаемым всем.
	if err := os.Chmod(tmp, 0o600); err != nil {
		return fmt.Errorf("chmod identity: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("persist identity %s: %w", path, err)
	}
	return nil
}
