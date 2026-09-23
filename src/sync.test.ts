import assert from "node:assert/strict";
import test from "node:test";
import { addManual, combineLocal, emptyStore, newVaultId, stampStore } from "./model.ts";
import { applyRemote, makeSyncLink, newSyncKey, openStore, readSyncLink, sameContent, sealStore } from "./sync.ts";

test("a sync link round-trips and a sealed desk opens only with its key", async () => {
  const desk = newVaultId();
  const key = newSyncKey();
  const link = makeSyncLink("https://horas.example/desk/", desk, key);
  assert.deepEqual(readSyncLink(link), { desk, key });
  assert.deepEqual(readSyncLink(`${desk}.${key}`), { desk, key });
  assert.equal(readSyncLink("not a link"), null);

  const store = stampStore({ ...emptyStore(), vaultId: desk });
  const sealed = await sealStore(store, key);
  const opened = await openStore(sealed, key);
  assert.equal(opened?.vaultId, desk);
  assert.equal(await openStore(sealed, newSyncKey()), null);
});

test("two devices keep both sets of hours on one desk", () => {
  const phoneId = newVaultId();
  const computerId = newVaultId();
  const phoneJob = emptyStore().jobs[0];
  const computerJob = emptyStore().jobs[0];
  const phoneHours = addManual([], {
    clockIn: combineLocal("2026-09-22", "09:00"),
    clockOut: combineLocal("2026-09-22", "12:00"),
    comment: "Phone",
    jobId: phoneJob.id,
  });
  const computerHours = addManual([], {
    clockIn: combineLocal("2026-09-22", "13:00"),
    clockOut: combineLocal("2026-09-22", "15:00"),
    comment: "Computer",
    jobId: computerJob.id,
  });
  assert.equal(phoneHours.ok && computerHours.ok, true);
  if (!phoneHours.ok || !computerHours.ok) return;
  const phone = stampStore({ ...emptyStore(), jobs: [phoneJob], activeJobId: phoneJob.id, entries: phoneHours.entries, vaultId: phoneId }, 1_000);
  const computer = stampStore(
    { ...emptyStore(), jobs: [computerJob], activeJobId: computerJob.id, entries: computerHours.entries, vaultId: computerId },
    2_000,
  );
  const merged = applyRemote(computer, phone, phoneId);
  assert.equal(merged.vaultId, phoneId);
  assert.deepEqual(
    merged.entries.map((entry) => entry.comment).sort(),
    ["Computer", "Phone"],
  );
  assert.equal(sameContent(merged, { ...merged, savedAt: merged.savedAt + 5 }), true);
});
