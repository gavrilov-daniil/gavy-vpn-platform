# Сборка node-agent. На ноду уезжает один статический бинарник:
# ни Docker, ни рантайма, ни зависимостей — только файл и systemd-юнит.
BINARY := node-agent
DIST := dist
LDFLAGS := -s -w

.PHONY: build linux linux-arm all check clean

## Локальная сборка (для отладки на машине разработчика)
build:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o $(DIST)/$(BINARY) .

## Основная цель: то, что реально едет на ноды
linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64 .

linux-arm:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64 .

all: linux linux-arm

## Прогнать перед коммитом
check:
	go vet ./...
	gofmt -l . | tee /dev/stderr | (! read)

clean:
	rm -rf $(DIST)
