package main

import (
	"path/filepath"
	"testing"
)

func TestSQLitePluginRegistryWriteFailureLeavesMemoryAndDatabaseUnchanged(t *testing.T) {
	db, err := newSQLiteBackend(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, _, _, _ := pluginFixture(t, db)
	before := store.state.Plugins["chat.core"]
	_, err = db.db.Exec(`CREATE TRIGGER plugin_fail BEFORE UPDATE ON plugin_registry BEGIN SELECT RAISE(ABORT,'simulated write failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.transitionPlugin(before.ID, "disable", before.Revision); err == nil {
		t.Fatal("database failure ignored")
	}
	after := store.state.Plugins[before.ID]
	if after.Status != before.Status || after.Revision != before.Revision {
		t.Fatal("memory changed after failed write")
	}
	records, _, err := db.loadPluginState()
	if err != nil || records[before.ID].Status != before.Status {
		t.Fatal("database changed after failed write")
	}
}
