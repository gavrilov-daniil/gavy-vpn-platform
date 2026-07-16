module vpn-platform/node-agent

go 1.23

// No external dependencies by design: the agent must build as a single static
// binary (CGO_ENABLED=0) and ship without a package manager on the node.
// Everything is stdlib (crypto/tls, crypto/rsa, crypto/ecdh, net/http, ...).
