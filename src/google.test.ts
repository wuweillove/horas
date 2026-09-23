import assert from "node:assert/strict";
import test from "node:test";
import { deskFromGoogle, GOOGLE_CLIENT_ID, readGoogleCredential } from "./google.ts";
import { emptyStore, stampStore } from "./model.ts";
import { openStore, sealStore } from "./sync.ts";

test("one Google account maps to one desk", async () => {
  const first = await deskFromGoogle("108234987234987234987");
  const again = await deskFromGoogle("108234987234987234987");
  const other = await deskFromGoogle("108234987234987234988");
  assert.equal(first.desk, again.desk);
  assert.equal(first.key, again.key);
  assert.match(first.desk, /^[a-f0-9]{20}$/);
  assert.notEqual(first.desk, other.desk);
  assert.notEqual(first.key, other.key);

  const store = stampStore({ ...emptyStore(), vaultId: first.desk });
  const sealed = await sealStore(store, first.key);
  assert.equal((await openStore(sealed, first.key))?.vaultId, first.desk);
  assert.equal(await openStore(sealed, other.key), null);
});

test("a Google credential carries the account id", () => {
  const payload = b64url({ sub: "108234987234987234987", email: "ada@example.com", name: "Ada" });
  assert.deepEqual(readGoogleCredential(`header.${payload}.sig`), {
    sub: "108234987234987234987",
    email: "ada@example.com",
    name: "Ada",
  });
  assert.equal(readGoogleCredential("not-a-token"), null);
  assert.equal(readGoogleCredential(`header.${b64url({ email: "ada@example.com" })}.sig`), null);
});

test("the published Google client id is the web client", () => {
  assert.match(GOOGLE_CLIENT_ID, /^183398708833-cta2th8jp26b6l1hvll1fb9au53ujs51\.apps\.googleusercontent\.com$/);
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
