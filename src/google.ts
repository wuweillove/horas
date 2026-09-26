export const GOOGLE_CLIENT_ID = "183398708833-cta2th8jp26b6l1hvll1fb9au53ujs51.apps.googleusercontent.com";

const ACCOUNT_KEY = "horas.google";
const OWNER_KEY = "horas.deskOwner";

export type GoogleProfile = { sub: string; email: string; name: string };
export type GoogleAccount = GoogleProfile & { desk: string };

type Gis = {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: { credential?: string }) => void;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }) => void;
      renderButton: (parent: HTMLElement, options: Record<string, string | number>) => void;
      disableAutoSelect: () => void;
      revoke: (hint: string, done: () => void) => void;
    };
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        include_granted_scopes?: boolean;
        callback: (response: { access_token?: string; expires_in?: number; error?: string; scope?: string }) => void;
        error_callback?: () => void;
      }) => {
        requestAccessToken: (override?: { prompt?: string; login_hint?: string }) => void;
      };
    };
  };
};

declare global {
  interface Window {
    google?: Gis;
  }
}

type GoogleClaims = GoogleProfile & { iss?: unknown; aud?: unknown; exp?: unknown };

function readClaims(credential: string): GoogleClaims | null {
  const part = credential.split(".")[1];
  if (!part) return null;
  const bytes = decodeB64(part);
  if (!bytes) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown; email?: unknown; name?: unknown; iss?: unknown; aud?: unknown; exp?: unknown };
    if (typeof json.sub !== "string" || !/^[A-Za-z0-9_-]{4,255}$/.test(json.sub)) return null;
    return {
      sub: json.sub,
      email: typeof json.email === "string" ? json.email.trim().slice(0, 320) : "",
      name: typeof json.name === "string" ? json.name.trim().slice(0, 200) : "",
      iss: json.iss,
      aud: json.aud,
      exp: json.exp,
    };
  } catch {
    return null;
  }
}


export async function profileFromAccessToken(token: string): Promise<GoogleProfile | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { sub?: unknown; email?: unknown; name?: unknown };
    if (typeof body.sub !== "string" || !/^[A-Za-z0-9_-]{4,255}$/.test(body.sub)) return null;
    return {
      sub: body.sub,
      email: typeof body.email === "string" ? body.email.trim().slice(0, 320) : "",
      name: typeof body.name === "string" ? body.name.trim().slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

/** Parses a JWT payload. Sign-in must use verifyGoogleCredential, which checks the signature. */
export function readGoogleCredential(credential: string): GoogleProfile | null {
  const claims = readClaims(credential);
  if (!claims) return null;
  return { sub: claims.sub, email: claims.email, name: claims.name };
}

let cachedCerts: { at: number; keys: JsonWebKey[] } | null = null;

async function loadGoogleCerts(): Promise<JsonWebKey[]> {
  if (cachedCerts && Date.now() - cachedCerts.at < 60 * 60 * 1000) return cachedCerts.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) return cachedCerts?.keys ?? [];
  const body = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cachedCerts = { at: Date.now(), keys };
  return keys;
}

/**
 * Accepts a Google ID token only when the signature, issuer, audience, and expiry check out.
 * `loadKeys` is injectable for tests.
 */
export async function verifyGoogleCredential(
  credential: string,
  loadKeys: () => Promise<JsonWebKey[]> = loadGoogleCerts,
): Promise<GoogleProfile | null> {
  const parts = credential.split(".");
  if (parts.length !== 3) return null;
  const headerBytes = decodeB64(parts[0]);
  const signature = decodeB64(parts[2]);
  const claims = readClaims(credential);
  if (!headerBytes || !signature || !claims) return null;
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as { alg?: unknown; kid?: unknown };
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const issuer = claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com";
  const audience = claims.aud === GOOGLE_CLIENT_ID || (Array.isArray(claims.aud) && claims.aud.includes(GOOGLE_CLIENT_ID));
  if (!issuer || !audience || typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) return null;
  let keys: JsonWebKey[] = [];
  try {
    keys = await loadKeys();
  } catch {
    return null;
  }
  const jwk = keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid && key.kty === "RSA");
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signatureBytes = new Uint8Array(signature.byteLength);
    signatureBytes.set(signature);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  return { sub: claims.sub, email: claims.email, name: claims.name };
}

/** Stable desk id for an old install. The encryption key is no longer derived from the account. */
export async function deskFromGoogle(sub: string): Promise<{ desk: string }> {
  const deskBytes = await sha256(`horas.desk.v1:${sub}`);
  const desk = [...deskBytes.subarray(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { desk };
}

/** Key used by installs that sealed the desk with the Google account id. Only for re-sealing. */
export async function legacyKeyFromGoogle(sub: string): Promise<string> {
  const keyBytes = await sha256(`horas.key.v1:${sub}`);
  return bytesToB64(keyBytes);
}

export function loadGoogleAccount(): GoogleAccount | null {
  const raw = readStorage(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleAccount>;
    if (typeof parsed.sub !== "string" || typeof parsed.desk !== "string" || !/^[a-f0-9]{20}$/.test(parsed.desk)) return null;
    return {
      sub: parsed.sub,
      email: typeof parsed.email === "string" ? parsed.email : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
      desk: parsed.desk,
    };
  } catch {
    return null;
  }
}

export function saveGoogleAccount(account: GoogleAccount): void {
  writeStorage(ACCOUNT_KEY, JSON.stringify(account));
}

export function clearGoogleAccount(): void {
  removeStorage(ACCOUNT_KEY);
}

export function loadDeskOwner(): string {
  return readStorage(OWNER_KEY) ?? "";
}

export function saveDeskOwner(sub: string): void {
  writeStorage(OWNER_KEY, sub);
}

let gisPromise: Promise<void> | null = null;

export function loadGis(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve) => {
      let script = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        document.head.appendChild(script);
      }
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (window.google?.accounts?.id || Date.now() - started > 8000) {
          window.clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }
  return gisPromise;
}

export function signOutGoogle(email: string): void {
  const gis = window.google?.accounts?.id;
  if (!gis) return;
  gis.disableAutoSelect();
  if (email) gis.revoke(email, () => undefined);
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeB64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}
