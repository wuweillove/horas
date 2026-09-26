import assert from "node:assert/strict";
import test from "node:test";
import { emptyStore, newVaultId, stampStore } from "./model.ts";
import { newSyncKey, openStore, pullDesk, saveDesk, sealStore } from "./sync.ts";
import { parseDriveRecord } from "./drive.ts";

test("a drive file keeps the key beside the sealed desk", async () => {
  const desk = newVaultId();
  const key = newSyncKey();
  const store = stampStore({ ...emptyStore(), vaultId: desk });
  const blob = await sealStore(store, key);
  const parsed = parseDriveRecord({ v: 1, desk, key, rev: 2, blob });
  assert.ok(parsed);
  assert.equal(parsed.key, key);
  assert.equal(parsed.desk, desk);
  assert.equal(parsed.rev, 2);
  const opened = await openStore(parsed.blob, parsed.key);
  assert.equal(opened?.vaultId, desk);
  assert.equal(parseDriveRecord({ v: 1, desk: "nope", key, rev: 1, blob }), null);
  assert.equal(parseDriveRecord({ v: 2, desk, key, rev: 1, blob }), null);
  assert.equal(parseDriveRecord({ v: 1, desk, key: "short", rev: 1, blob }), null);
});

test("without Google Drive the desk stays on this browser", async () => {
  const desk = newVaultId();
  const key = newSyncKey();
  const store = stampStore({ ...emptyStore(), vaultId: desk });
  assert.deepEqual(await pullDesk(desk, key), { ok: true, rev: 0, store: null });
  const saved = await saveDesk(desk, key, store);
  assert.equal(saved.ok, true);
  if (saved.ok) assert.equal(saved.store.vaultId, desk);
});
