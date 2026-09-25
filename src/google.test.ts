import assert from "node:assert/strict";
import test from "node:test";
import { deskFromGoogle, GOOGLE_CLIENT_ID, legacyKeyFromGoogle, readGoogleCredential, verifyGoogleCredential } from "./google.ts";
import { emptyStore, stampStore } from "./model.ts";
import { newSyncKey, openStore, sealStore } from "./sync.ts";

test("one Google account maps to one desk, and the key is not the account", async () => {
  const first = await deskFromGoogle("108234987234987234987");
  const again = await deskFromGoogle("108234987234987234987");
  const other = await deskFromGoogle("108234987234987234988");
  assert.equal(first.desk, again.desk);
  assert.match(first.desk, /^[a-f0-9]{20}$/);
  assert.notEqual(first.desk, other.desk);

  const legacy = await legacyKeyFromGoogle("108234987234987234987");
  const fresh = newSyncKey();
  assert.notEqual(legacy, fresh);
  const store = stampStore({ ...emptyStore(), vaultId: first.desk });
  const sealed = await sealStore(store, legacy);
  assert.equal((await openStore(sealed, legacy))?.vaultId, first.desk);
  assert.equal(await openStore(sealed, fresh), null);
});

test("a Google credential is accepted only with a valid signature", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const claims = {
    sub: "108234987234987234987",
    email: "ada@example.com",
    name: "Ada",
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const token = await signedToken(pair.privateKey, claims);
  assert.deepEqual(await verifyGoogleCredential(token, async () => [jwk]), {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
  });
  assert.equal(await verifyGoogleCredential(`${token}x`, async () => [jwk]), null);
  assert.equal(await verifyGoogleCredential(token, async () => []), null);
  const expired = await signedToken(pair.privateKey, { ...claims, exp: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(await verifyGoogleCredential(expired, async () => [jwk]), null);
  const otherApp = await signedToken(pair.privateKey, { ...claims, aud: "someone-else.apps.googleusercontent.com" });
  assert.equal(await verifyGoogleCredential(otherApp, async () => [jwk]), null);
  assert.equal(readGoogleCredential("not-a-token"), null);
});

test("the published Google client id is the web client", () => {
  assert.match(GOOGLE_CLIENT_ID, /^183398708833-cta2th8jp26b6l1hvll1fb9au53ujs51\.apps\.googleusercontent\.com$/);
});

async function signedToken(key: CryptoKey, claims: unknown): Promise<string> {
  const header = b64url({ alg: "RS256", kid: "test-key" });
  const payload = b64url(claims);
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
