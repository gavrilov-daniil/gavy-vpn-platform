package config

import (
	"os"
	"testing"
)

func TestLoadIdentityMissingIsNotAnError(t *testing.T) {
	id, err := LoadIdentity(t.TempDir())
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	if id != nil {
		t.Fatalf("got %+v, want nil (нода ещё не энроллилась)", id)
	}
}

func TestSaveIdentityRoundTripAndPerms(t *testing.T) {
	dir := t.TempDir()
	want := Identity{NodeID: "node-1", AgentToken: "secret-token", AgentEpoch: "3", EnrolledAt: "2026-07-26T10:00:00Z"}

	if err := SaveIdentity(dir, want); err != nil {
		t.Fatalf("SaveIdentity: %v", err)
	}

	// Токен лежит на диске в открытом виде — файл не должен быть читаем никем, кроме владельца.
	info, err := os.Stat(IdentityPath(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 600", perm)
	}

	got, err := LoadIdentity(dir)
	if err != nil {
		t.Fatalf("LoadIdentity: %v", err)
	}
	if got == nil || *got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestSaveIdentityOverwritesStaleTempFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(IdentityPath(dir)+".tmp", []byte("{}"), 0o644); err != nil {
		t.Fatalf("seed tmp: %v", err)
	}

	if err := SaveIdentity(dir, Identity{NodeID: "node-1", AgentToken: "t"}); err != nil {
		t.Fatalf("SaveIdentity: %v", err)
	}
	info, err := os.Stat(IdentityPath(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 600 (права уцелевшего .tmp не должны наследоваться)", perm)
	}
}

func TestLoadIdentityCorruptIsAnError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(IdentityPath(dir), []byte("{не json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := LoadIdentity(dir); err == nil {
		t.Fatal("битый identity должен быть ошибкой, а не молчаливым «нода не энроллена»")
	}
}
