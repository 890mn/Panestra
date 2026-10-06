package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreRejectsCorruptAndFutureDatabaseWithoutChangingLiveState(t *testing.T) {
	s := testStore(t)
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "corrupt.db")
	if err := os.WriteFile(corrupt, []byte("not a database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Restore(context.Background(), corrupt); err == nil {
		t.Fatal("corrupt restore accepted")
	}
	future := filepath.Join(dir, "future.db")
	if err := s.Backup(context.Background(), future); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", future)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("PRAGMA user_version=3"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err = s.Restore(context.Background(), future); err == nil {
		t.Fatal("future schema restore accepted")
	}
	if opened, err := Open(future); err == nil {
		opened.DB.Close()
		t.Fatal("future schema silently downgraded")
	}
	snap, err := s.Snapshot()
	if err != nil || snap.ServerSeq != 0 || len(snap.Entities) != 22 {
		t.Fatal("failed restore changed live database", err, len(snap.Entities))
	}
}
