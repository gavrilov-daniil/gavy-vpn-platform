module vpn-platform/node-agent

go 1.24

// No external dependencies by design: the agent must build as a single static
// binary (CGO_ENABLED=0) and ship without a package manager on the node.
// Everything is stdlib (crypto/tls, crypto/rsa, crypto/ecdh, net/http, ...).
//
// Go 1.24 — минимум по необходимости, а не «свежее лучше»: gRPC-клиент к
// локальному StatsService Xray работает по h2c, а нативный h2c без
// golang.org/x/net/http2 появился только в 1.24 (net/http.Protocols
// .SetUnencryptedHTTP2). См. internal/xray/statsclient.go.
