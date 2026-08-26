/**
 * Auth seam (ADR 0004 P1). Talks to Supabase GoTrue when provisioned.
 *
 * Honest: if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing, every
 * sign-in/up call fails with a precise reason and `currentUser()` is null. The
 * UI must never invent a logged-in session. Session tokens live in localStorage
 * under `viro.session` and are never treated as entitlements.
 */
import { flag } from "./flags";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
}

const SESSION_KEY = "viro.session";

export function supabaseConfig(): { url: string; anon: string } | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
    const url = (env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
    const anon = env.VITE_SUPABASE_ANON_KEY ?? "";
    if (!url || !anon) return null;
    return { url, anon };
  } catch {
    return null;
  }
}

/** True only when the owner has provisioned Supabase AND the cloud flag is on. */
export function authAvailable(): boolean {
  return flag("platform.cloud") && supabaseConfig() !== null;
}

export function currentSession(): AuthSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.accessToken || !parsed.user?.id || !parsed.user?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function currentUser(): AuthUser | null {
  return currentSession()?.user ?? null;
}

export function signOut(): void {
  try {
    globalThis.localStorage?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function signUp(email: string, password: string): Promise<AuthSession> {
  const cfg = requireConfig();
  const res = await fetch(`${cfg.url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: cfg.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  return takeSession(res, "sign up");
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  const cfg = requireConfig();
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: cfg.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  return takeSession(res, "sign in");
}

function requireConfig(): { url: string; anon: string } {
  if (!flag("platform.cloud")) {
    throw new Error("Cloud sign-in is off — enable platform.cloud after Supabase is provisioned");
  }
  const cfg = supabaseConfig();
  if (!cfg) {
    throw new Error("Sign-in is not provisioned yet — missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
  }
  return cfg;
}

async function takeSession(res: Response, verb: string): Promise<AuthSession> {
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user?: { id?: string; email?: string };
    msg?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token || !body.user?.id) {
    const reason = body.msg || body.error_description || body.error || `${res.status}`;
    throw new Error(`Could not ${verb}: ${reason}`);
  }
  const session: AuthSession = {
    accessToken: body.access_token,
    user: { id: body.user.id, email: body.user.email || "" },
  };
  try {
    globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode — session lasts this tab only */
  }
  return session;
}
