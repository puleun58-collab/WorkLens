import { workerEnv } from "./cf-env";

/**
 * Minimal admin auth: a server-checked password from a Cloudflare Secret plus a
 * signed, HttpOnly session cookie. No user store, no password in the bundle.
 */
export const ADMIN_COOKIE = "worklens_admin";
const SESSION_TTL_SECONDS = 4 * 60 * 60;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const attempts = new Map<string, { count: number; until: number }>();

export class AdminAuthError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

function encoder(): TextEncoder {
  return new TextEncoder();
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=+$/u, "");
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = encoder().encode(left);
  const b = encoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export function rateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "local";
}

export function assertNotLockedOut(key: string): void {
  const entry = attempts.get(key);
  if (entry && entry.count >= MAX_ATTEMPTS && Date.now() < entry.until) {
    throw new AdminAuthError("TOO_MANY_ATTEMPTS", 429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
  }
}

function recordFailure(key: string): void {
  const entry = attempts.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, entry);
}

/** Verifies the password and returns the `Set-Cookie` value for the session. */
export async function createAdminSession(request: Request, password: string): Promise<string> {
  const key = rateLimitKey(request);
  assertNotLockedOut(key);
  const env = workerEnv();
  const expected = env.WORKLENS_ADMIN_PASSWORD;
  const secret = env.WORKLENS_ADMIN_SESSION_SECRET;
  if (!expected || !secret) throw new AdminAuthError("ADMIN_NOT_CONFIGURED", 503, "관리자 인증이 구성되지 않았습니다.");
  if (!constantTimeEquals(password, expected)) {
    recordFailure(key);
    throw new AdminAuthError("INVALID_PASSWORD", 401, "비밀번호가 올바르지 않습니다.");
  }
  attempts.delete(key);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `admin.${expires}`;
  const token = `${payload}.${await sign(payload, secret)}`;
  return `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearAdminSession(): string {
  return `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ADMIN_COOKIE) return value.join("=");
  }
  return null;
}

export async function hasAdminSession(request: Request): Promise<boolean> {
  const token = readCookie(request);
  if (!token) return false;
  const secret = (workerEnv()).WORKLENS_ADMIN_SESSION_SECRET;
  if (!secret) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!constantTimeEquals(signature, await sign(payload, secret))) return false;
  const expires = Number(payload.split(".")[1]);
  return Number.isFinite(expires) && expires > Math.floor(Date.now() / 1000);
}

export async function requireAdmin(request: Request): Promise<void> {
  if (!(await hasAdminSession(request))) {
    throw new AdminAuthError("ADMIN_UNAUTHORIZED", 401, "관리자 인증이 필요합니다.");
  }
}
