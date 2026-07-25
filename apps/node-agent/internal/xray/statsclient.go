package xray

// Клиент Xray gRPC StatsService на голом stdlib.
//
// Почему не google.golang.org/grpc (осознанный выбор, а не экономия):
// агенту нужен РОВНО ОДИН unary-вызов — QueryStats с двумя сообщениями на
// четыре поля суммарно. grpc-go тянет за собой protobuf-рантайм и
// сгенерированные stubs Xray (а те — половину xray-core), то есть несколько
// мегабайт и внешние модули ради одного RPC. При этом gRPC поверх HTTP/2 — это
// POST с пятибайтовым префиксом кадра и статусом в трейлере, а net/http с
// Go 1.24 умеет h2c нативно (Protocols.SetUnencryptedHTTP2). Поэтому весь
// клиент помещается в этот файл и go.mod остаётся без зависимостей — агент
// как ехал одним статическим бинарником, так и едет.
//
// Обратная сторона: proto-сообщения кодируются руками. Это безопасно ровно
// потому, что схема QueryStats заморожена ещё во времена v2ray и Xray её только
// дополняет новыми полями (patterns=3, regexp=4) — неизвестные поля декодер
// пропускает, а не падает на них.

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"vpn-platform/node-agent/internal/stats"
)

// Полное имя метода из app/stats/command/command.proto:
// package xray.app.stats.command; service StatsService { rpc QueryStats(...) }
const queryStatsMethod = "/xray.app.stats.command.StatsService/QueryStats"

// Потолок на ответ. На ноде с тысячей юзеров ответ — сотни килобайт, так что
// это защита от испорченного length-префикса, а не рабочее ограничение.
const maxResponseBytes = 16 << 20

// protobuf wire types (нужны только эти).
const (
	wireVarint = iota
	wireFixed64
	wireBytes
	_ // 3: start group, deprecated
	_ // 4: end group, deprecated
	wireFixed32
)

type statsClient struct {
	endpoint string
	httpc    *http.Client
}

func newStatsClient(apiAddr string) *statsClient {
	// h2c prior-knowledge: api-инбаунд Xray — это dokodemo-door на localhost,
	// голый TCP без TLS. HTTP/1 выключен намеренно: gRPC по нему не работает, и
	// молчаливый фолбэк дал бы невнятную ошибку вместо явной.
	var protocols http.Protocols
	protocols.SetHTTP1(false)
	protocols.SetUnencryptedHTTP2(true)

	return &statsClient{
		endpoint: "http://" + apiAddr,
		httpc: &http.Client{
			// Локальный вызов: если Xray не отвечает за 10 секунд, он не отвечает
			// вовсе, а reconcile-цикл ждать не должен.
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				Protocols:       &protocols,
				MaxIdleConns:    2,
				IdleConnTimeout: 90 * time.Second,
			},
		},
	}
}

// QueryStats возвращает счётчики Xray. При reset=true Xray отдаёт значение и тут
// же обнуляет счётчик, то есть ответ — это дельта с прошлого вызова.
func (c *statsClient) QueryStats(ctx context.Context, pattern string, reset bool) ([]stats.Counter, error) {
	body, err := c.invoke(ctx, queryStatsMethod, encodeQueryStatsRequest(pattern, reset))
	if err != nil {
		return nil, err
	}
	return decodeQueryStatsResponse(body)
}

// invoke выполняет unary gRPC-вызов и возвращает тело единственного ответного
// сообщения.
func (c *statsClient) invoke(ctx context.Context, method string, msg []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+method, bytes.NewReader(encodeFrame(msg)))
	if err != nil {
		return nil, fmt.Errorf("xray stats: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/grpc+proto")
	req.Header.Set("Te", "trailers")
	// Сжатие не поддерживаем: разжимать кадр было бы нечем.
	req.Header.Set("Grpc-Accept-Encoding", "identity")

	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("xray stats: %s: %w", method, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("xray stats: %s: http status %d", method, resp.StatusCode)
	}
	// Trailers-Only: gRPC-ошибка приезжает прямо в заголовках, тела нет вовсе.
	if err := grpcStatusError(resp.Header); err != nil {
		return nil, err
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("xray stats: read response: %w", err)
	}
	// Трейлеры доступны только после дочитывания тела — поэтому статус
	// проверяется здесь, а не сразу после Do.
	if err := grpcStatusError(resp.Trailer); err != nil {
		return nil, err
	}
	return decodeFrame(raw)
}

// encodeFrame оборачивает сообщение в gRPC length-prefixed кадр:
// 1 байт флага сжатия + 4 байта длины (big-endian) + payload.
func encodeFrame(msg []byte) []byte {
	frame := make([]byte, 5+len(msg))
	frame[0] = 0 // не сжато
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(msg)))
	copy(frame[5:], msg)
	return frame
}

// decodeFrame достаёт payload первого кадра. Для unary-ответа кадр ровно один;
// остальное (если вдруг есть) игнорируем — читать нечего.
func decodeFrame(raw []byte) ([]byte, error) {
	if len(raw) < 5 {
		return nil, fmt.Errorf("xray stats: truncated grpc frame (%d bytes)", len(raw))
	}
	if raw[0] != 0 {
		return nil, errors.New("xray stats: response is compressed, but identity encoding was requested")
	}
	size := binary.BigEndian.Uint32(raw[1:5])
	if uint64(size) > uint64(len(raw)-5) {
		return nil, fmt.Errorf("xray stats: grpc frame claims %d bytes, got %d", size, len(raw)-5)
	}
	return raw[5 : 5+size], nil
}

// grpcStatusError превращает ненулевой grpc-status в ошибку. Пустой статус —
// не ошибка: у успешного ответа Xray он "0", а некоторые прокси его не доносят.
func grpcStatusError(h http.Header) error {
	if h == nil {
		return nil
	}
	code := strings.TrimSpace(h.Get("Grpc-Status"))
	if code == "" || code == "0" {
		return nil
	}
	if msg := h.Get("Grpc-Message"); msg != "" {
		return fmt.Errorf("xray stats: grpc status %s: %s", code, msg)
	}
	return fmt.Errorf("xray stats: grpc status %s", code)
}

// --- protobuf ---------------------------------------------------------------

// encodeQueryStatsRequest кодирует QueryStatsRequest{pattern=1, reset=2}.
// Поля с дефолтными значениями proto3 не пишет.
func encodeQueryStatsRequest(pattern string, reset bool) []byte {
	var buf []byte
	if pattern != "" {
		buf = appendVarint(buf, fieldKey(1, wireBytes))
		buf = appendVarint(buf, uint64(len(pattern)))
		buf = append(buf, pattern...)
	}
	if reset {
		buf = appendVarint(buf, fieldKey(2, wireVarint))
		buf = appendVarint(buf, 1)
	}
	return buf
}

// decodeQueryStatsResponse разбирает QueryStatsResponse{repeated Stat stat = 1}.
func decodeQueryStatsResponse(msg []byte) ([]stats.Counter, error) {
	var out []stats.Counter
	err := scanFields(msg, func(field, wire int, num uint64, data []byte) error {
		if field != 1 || wire != wireBytes {
			return nil
		}
		c, err := decodeStat(data)
		if err != nil {
			return err
		}
		out = append(out, c)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("xray stats: decode QueryStatsResponse: %w", err)
	}
	return out, nil
}

// decodeStat разбирает Stat{name=1 string, value=2 int64}.
func decodeStat(msg []byte) (stats.Counter, error) {
	var c stats.Counter
	err := scanFields(msg, func(field, wire int, num uint64, data []byte) error {
		switch {
		case field == 1 && wire == wireBytes:
			c.Name = string(data)
		case field == 2 && wire == wireVarint:
			// proto3 int64 — обычный varint, без zigzag.
			c.Value = int64(num)
		}
		return nil
	})
	if err != nil {
		return stats.Counter{}, fmt.Errorf("stat: %w", err)
	}
	return c, nil
}

// scanFields обходит поля protobuf-сообщения. Неизвестные поля пропускаются, а
// не считаются ошибкой: Xray дополняет схему между версиями (в QueryStatsRequest
// так появились patterns и regexp), и агент не должен падать на обновлении ноды.
func scanFields(msg []byte, fn func(field, wire int, num uint64, data []byte) error) error {
	for len(msg) > 0 {
		key, n := binary.Uvarint(msg)
		if n <= 0 {
			return errors.New("malformed field key")
		}
		msg = msg[n:]

		field, wire := int(key>>3), int(key&7)
		if field <= 0 {
			return fmt.Errorf("invalid field number %d", field)
		}

		var (
			num  uint64
			data []byte
		)
		switch wire {
		case wireVarint:
			v, n := binary.Uvarint(msg)
			if n <= 0 {
				return fmt.Errorf("field %d: malformed varint", field)
			}
			num, msg = v, msg[n:]
		case wireFixed64:
			if len(msg) < 8 {
				return fmt.Errorf("field %d: truncated fixed64", field)
			}
			num, msg = binary.LittleEndian.Uint64(msg), msg[8:]
		case wireBytes:
			size, n := binary.Uvarint(msg)
			if n <= 0 {
				return fmt.Errorf("field %d: malformed length", field)
			}
			msg = msg[n:]
			if size > uint64(len(msg)) {
				return fmt.Errorf("field %d: length %d exceeds %d remaining bytes", field, size, len(msg))
			}
			data, msg = msg[:size], msg[size:]
		case wireFixed32:
			if len(msg) < 4 {
				return fmt.Errorf("field %d: truncated fixed32", field)
			}
			num, msg = uint64(binary.LittleEndian.Uint32(msg)), msg[4:]
		default:
			// 3/4 — deprecated groups; их Xray не использует, а пропустить нельзя
			// без разбора вложенности, поэтому честно останавливаемся.
			return fmt.Errorf("field %d: unsupported wire type %d", field, wire)
		}

		if err := fn(field, wire, num, data); err != nil {
			return err
		}
	}
	return nil
}

func fieldKey(field, wire int) uint64 { return uint64(field)<<3 | uint64(wire) }

func appendVarint(buf []byte, v uint64) []byte {
	return binary.AppendUvarint(buf, v)
}
