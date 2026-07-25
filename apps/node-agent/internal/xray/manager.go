// Package xray manages the local Xray process and its Reality keypair.
package xray

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"vpn-platform/node-agent/internal/config"
	"vpn-platform/node-agent/internal/stats"
)

// realityPrivateKeyPlaceholder — то, что control-plane кладёт в
// realitySettings.privateKey вместо самого ключа.
const realityPrivateKeyPlaceholder = "__REALITY_PRIVATE_KEY__"

// Manager drives Xray via systemd and reads its traffic counters over the local
// gRPC API.
type Manager struct {
	systemdUnit string
	// realityPrivateKeyPath держит приватник Reality внутри пакета: наружу отдаётся
	// только публичная половина, и ключ не попадает ни в структуры, ни в логи.
	realityPrivateKeyPath string
	// statsClient == nil, когда адрес api-инбаунда не задан: тогда Stats честно
	// возвращает ошибку, а не делает вид, что счётчиков нет.
	statsClient *statsClient
}

// NewManager. apiAddr — адрес api-инбаунда Xray ("127.0.0.1:10085" в конфиге,
// который собирает control-plane). Пустой адрес отключает чтение статистики.
func NewManager(systemdUnit, realityPrivateKeyPath, apiAddr string) *Manager {
	m := &Manager{systemdUnit: systemdUnit, realityPrivateKeyPath: realityPrivateKeyPath}
	if apiAddr != "" {
		m.statsClient = newStatsClient(apiAddr)
	}
	return m
}

// WriteConfig atomically writes the full Xray config. It validates JSON first so
// a malformed desired-state can never leave a broken config that fails to start
// Xray on the next restart.
func (m *Manager) WriteConfig(path string, cfg []byte) error {
	if !json.Valid(cfg) {
		return errors.New("xray: refusing to write invalid JSON config")
	}
	withKey, err := m.injectRealityPrivateKey(cfg)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, withKey, 0o600); err != nil {
		return fmt.Errorf("xray: write config %s: %w", path, err)
	}
	return nil
}

// injectRealityPrivateKey подставляет локальный приватник Reality вместо
// плейсхолдера, пришедшего из desired-state.
//
// Почему так: приватник Reality никогда не покидает ноду — control-plane его не
// знает и знать не должен, поэтому в конфиге приходит строка-плейсхолдер. Без
// подстановки Xray просто не стартует. Ключ берётся из локального файла, а при
// миграции существующей ноды он ИМПОРТИРУЕТСЯ, а не генерируется: смена ключа
// сменила бы pbk в строке подключения и порвала всех уже подключённых клиентов.
//
// Замена — на уровне байт, а не через unmarshal/marshal: конфиг доезжает до
// файла ровно таким, каким его собрал control-plane (числа, порядок ключей,
// пробелы не переписываются).
func (m *Manager) injectRealityPrivateKey(cfg []byte) ([]byte, error) {
	token := []byte(`"` + realityPrivateKeyPlaceholder + `"`)
	if !bytes.Contains(cfg, token) {
		return cfg, nil // на ноде может не быть reality-инбаунда — подставлять нечего
	}
	key, err := m.readRealityPrivateKey()
	if err != nil {
		return nil, err
	}
	return bytes.ReplaceAll(cfg, token, []byte(`"`+key+`"`)), nil
}

func (m *Manager) readRealityPrivateKey() (string, error) {
	if m.realityPrivateKeyPath == "" {
		return "", errors.New("xray: reality private key path is empty")
	}
	raw, err := os.ReadFile(m.realityPrivateKeyPath)
	if err != nil {
		return "", fmt.Errorf("xray: read reality private key: %w", err)
	}
	key := strings.TrimSpace(string(raw))
	// Ключ уходит внутрь JSON-строки как есть, поэтому формат проверяем до
	// подстановки: мусор с кавычкой или переводом строки сломал бы весь конфиг.
	if !isBase64Key(key) {
		return "", fmt.Errorf("xray: reality private key %s is not a base64 x25519 key", m.realityPrivateKeyPath)
	}
	return key, nil
}

func isBase64Key(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '+', r == '/', r == '=':
		default:
			return false
		}
	}
	return true
}

// Reload asks systemd to reload the unit (SIGHUP-style, keeps connections).
func (m *Manager) Reload(ctx context.Context) error { return m.systemctl(ctx, "reload") }

// Restart fully restarts Xray. v1 uses this after any config change because
// users are part of the full config and Xray has no built-in hot user reload.
func (m *Manager) Restart(ctx context.Context) error { return m.systemctl(ctx, "restart") }

func (m *Manager) systemctl(ctx context.Context, verb string) error {
	cmd := exec.CommandContext(ctx, "systemctl", verb, m.systemdUnit)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("xray: systemctl %s %s: %w: %s", verb, m.systemdUnit, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// Version returns the first line of `xray version`.
func (m *Manager) Version(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "xray", "version").Output()
	if err != nil {
		return "", fmt.Errorf("xray: version: %w", err)
	}
	line := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	return line, nil
}

// Stats снимает счётчики трафика через локальный gRPC StatsService и ОБНУЛЯЕТ
// их (QueryStats с reset=true), то есть возвращает дельту с прошлого вызова.
// Пустой pattern — «все счётчики»: user>>>, inbound>>>, outbound>>>.
//
// Почему reset=true, а не накопительное чтение: без сброса Xray отдаёт
// кумулятивные значения, которые обнуляются при каждом рестарте процесса. Тогда
// дельту пришлось бы считать вычитанием и отличать «рестарт» от «переполнения»
// эвристикой по убыванию значения — источник тихих ошибок учёта. Со сбросом
// каждое чтение самодостаточно.
//
// ПРИНЯТЫЙ КОМПРОМИСС (потеря дельты при краше). Чтение деструктивно: между
// ответом Xray и записью в durable-буфер дельта существует только в памяти
// процесса. Падение агента ровно в этом окне теряет её безвозвратно —
// восстанавливать нечего, счётчик в Xray уже нулевой. Мы это принимаем
// осознанно: трафик здесь метрика (лимиты подписки, анти-абьюз), а не деньги, и
// цена потери — недоучёт за один цикл. Атомарной альтернативы нет: в
// StatsService не существует чтения с подтверждением (read → ack → reset).
// Практический вывод для вызывающего — писать дельту на диск немедленно, до
// любых сетевых операций (см. reconcile.collectStats и durability invariant в
// пакете stats).
func (m *Manager) Stats(ctx context.Context) ([]stats.Counter, error) {
	if m.statsClient == nil {
		return nil, errors.New("xray: stats disabled (xray_api_addr is empty)")
	}
	return m.statsClient.QueryStats(ctx, "", true)
}

// RealityKeys is the PUBLIC half of the node's Reality identity, safe to report
// to the control plane. The private key is never included.
type RealityKeys struct {
	PublicKeyBase64 string
	ShortIDs        []string
}

// EnsureRealityKeypair returns the Reality public key + shortIDs, keeping the
// private key on the node.
//
// Brownfield migration invariant (P0): the Reality public key is baked into every
// client's connection string as pbk=. If it ever changes, EVERY existing client
// breaks. Hence:
//   - generate: create a keypair only if none exists; if the key file is already
//     present, reuse it. Re-running never rotates the pbk (idempotent).
//   - import: the key file MUST already exist (migrated from the old panel). This
//     mode NEVER generates — a missing file is a hard error, because silently
//     generating would rotate the pbk and disconnect the whole node.
func (m *Manager) EnsureRealityKeypair(mode config.KeypairMode) (RealityKeys, error) {
	privKeyPath := m.realityPrivateKeyPath
	if privKeyPath == "" {
		return RealityKeys{}, errors.New("xray: reality private key path is empty")
	}

	priv, err := loadPrivateKey(privKeyPath)
	switch {
	case err == nil:
		// Key already present: reuse in either mode to keep pbk stable.
	case errors.Is(err, os.ErrNotExist):
		if mode == config.KeypairModeImport {
			return RealityKeys{}, fmt.Errorf(
				"xray: import mode but %s is missing; refusing to generate (would rotate pbk and break every client)",
				privKeyPath)
		}
		priv, err = generatePrivateKey(privKeyPath)
		if err != nil {
			return RealityKeys{}, err
		}
	default:
		return RealityKeys{}, fmt.Errorf("xray: load reality private key: %w", err)
	}

	shortIDs, err := ensureShortIDs(privKeyPath + ".shortids")
	if err != nil {
		return RealityKeys{}, err
	}
	return RealityKeys{
		PublicKeyBase64: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		ShortIDs:        shortIDs,
	}, nil
}

func loadPrivateKey(path string) (*ecdh.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	enc := strings.TrimSpace(string(raw))
	dec, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		// Tolerate standard base64 too (some tooling emits it).
		dec, err = base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return nil, fmt.Errorf("decode x25519 key: %w", err)
		}
	}
	priv, err := ecdh.X25519().NewPrivateKey(dec)
	if err != nil {
		return nil, fmt.Errorf("invalid x25519 key: %w", err)
	}
	return priv, nil
}

func generatePrivateKey(path string) (*ecdh.PrivateKey, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("xray: generate reality keypair: %w", err)
	}
	enc := base64.RawURLEncoding.EncodeToString(priv.Bytes())
	if err := writeFileAtomic(path, []byte(enc+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("xray: persist reality private key: %w", err)
	}
	return priv, nil
}

func ensureShortIDs(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		var ids []string
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if s := strings.TrimSpace(line); s != "" {
				ids = append(ids, s)
			}
		}
		return ids, nil
	case errors.Is(err, os.ErrNotExist):
		// TODO(P0-migration): in import mode the shortIDs from the old panel should
		// be migrated too — a client that pinned sid= will break on a fresh one.
		// v1 fallback: generate a single shortId when none exists.
		id, err := randomShortID()
		if err != nil {
			return nil, err
		}
		if err := writeFileAtomic(path, []byte(id+"\n"), 0o600); err != nil {
			return nil, fmt.Errorf("xray: persist reality shortIDs: %w", err)
		}
		return []string{id}, nil
	default:
		return nil, fmt.Errorf("xray: read reality shortIDs: %w", err)
	}
}

func randomShortID() (string, error) {
	buf := make([]byte, 8) // Reality shortId: up to 8 bytes -> 16 hex chars.
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("xray: random shortId: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
