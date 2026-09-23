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
  };
};

declare global {
  interface Window {
    google?: Gis;
  }
}

export function readGoogleCredential(credential: string): GoogleProfile | null {
  const part = credential.split(".")[1];
  if (!part) return null;
  const bytes = decodeB64(part);
  if (!bytes) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown; email?: unknown; name?: unknown };
    if (typeof json.sub !== "string" || !/^[A-Za-z0-9_-]{4,255}$/.test(json.sub)) return null;
    return {
      sub: json.sub,
      email: typeof json.email === "string" ? json.email.trim().slice(0, 320) : "",
      name: typeof json.name === "string" ? json.name.trim().slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

/** Same Google account, same desk, on every device. */
export async function deskFromGoogle(sub: string): Promise<{ desk: string; key: string }> {
  const deskBytes = await sha256(`horas.desk.v1:${sub}`);
  const keyBytes = await sha256(`horas.key.v1:${sub}`);
  const desk = [...deskBytes.subarray(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { desk, key: bytesToB64(keyBytes) };
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
