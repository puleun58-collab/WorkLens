import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

const DEV_COOKIE = "worklens_session";
const PROD_COOKIE = "__Host-worklens_session";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const configuredTtl = Number(process.env.WORKLENS_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
if (!Number.isSafeInteger(configuredTtl) || configuredTtl <= 0 || configuredTtl > DEFAULT_SESSION_TTL_MS) {
  throw new Error("WORKLENS_SESSION_TTL_MS must be a positive integer no greater than two hours.");
}
export const SESSION_TTL_MS = configuredTtl;

export type SessionIdentity = {
  credential: string;
  principalKey: string;
};

type SessionState = SessionIdentity & {
  csrfToken: string;
  releases: Map<string, { nonce: string; releaseToken: string; claimed: boolean }>;
};

const sessions = new Map<string, SessionState>();

export function createSessionIdentity(): SessionIdentity {
  const credential = randomBytes(32).toString("base64url");
  return { credential, principalKey: principalFromCredential(credential) };
}

export function createSession(): SessionIdentity {
  const identity = createSessionIdentity();
  const session = {
    ...identity,
    csrfToken: randomBytes(32).toString("base64url"),
    releases: new Map(),
  };
  sessions.set(identity.credential, session);
  return identity;
}

export function principalFromCredential(credential: string): string {
  if (!SESSION_TOKEN_PATTERN.test(credential)) {
    throw new SessionError("SESSION_INVALID", "세션이 유효하지 않습니다.", 401);
  }
  return createHash("sha256").update(`worklens:v1:${credential}`).digest("hex");
}

export async function requireSession(): Promise<SessionIdentity> {
  const jar = await cookies();
  const credential = jar.get(sessionCookieName())?.value;
  if (!credential) {
    throw new SessionError("SESSION_REQUIRED", "브라우저 세션이 필요합니다.", 401);
  }
  principalFromCredential(credential);
  const session = sessions.get(credential);
  if (!session) {
    throw new SessionError("SESSION_REQUIRED", "세션이 만료되었습니다. 새 세션을 시작하세요.", 401);
  }
  return { credential: session.credential, principalKey: session.principalKey };
}

export function requireSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new SessionError("CROSS_SITE_REQUEST", "교차 사이트 요청을 거부했습니다.", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new SessionError("ORIGIN_REQUIRED", "요청 출처가 필요합니다.", 403);
  }
  let expected: string;
  try {
    const requestUrl = new URL(request.url);
    const configuredOrigin = process.env.WORKLENS_ORIGIN;
    if (process.env.NODE_ENV === "production" && !configuredOrigin) {
      throw new Error("WORKLENS_ORIGIN_REQUIRED");
    }
    expected = configuredOrigin ? new URL(configuredOrigin).origin : requestUrl.origin;
  } catch {
    throw new SessionError("ORIGIN_INVALID", "요청 출처를 확인할 수 없습니다.", 403);
  }
  if (origin !== expected) {
    throw new SessionError("ORIGIN_MISMATCH", "요청 출처가 일치하지 않습니다.", 403);
  }
  if (request.method === "GET" || request.method === "HEAD") return;
  const pathname = new URL(request.url).pathname;
  // Bootstrap creates the memory-held CSRF token. Beacon release cannot set a
  // header and instead authenticates with a single-use tab-bound nonce.
  if ((pathname === "/api/session" && request.method === "POST") || pathname === "/api/session/release") return;
  const credential = credentialFromCookieHeader(request.headers.get("cookie"));
  if (credential && sessions.has(credential)) requireCsrf(request, credential);
}

export function requireCsrf(request: Request, credential: string): void {
  const session = sessions.get(credential);
  const token = request.headers.get("x-worklens-csrf");
  if (!session || !token || token !== session.csrfToken) {
    throw new SessionError("CSRF_INVALID", "요청 검증 토큰이 유효하지 않습니다.", 403);
  }
}

function credentialFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  const prefix = `${sessionCookieName()}=`;
  for (const part of header.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

export function csrfTokenForSession(credential: string): string {
  const session = sessions.get(credential);
  if (!session) throw new SessionError("SESSION_REQUIRED", "세션이 만료되었습니다. 새 세션을 시작하세요.", 401);
  return session.csrfToken;
}

export function bindTabRelease(credential: string, tabId: string, releaseToken: string): string {
  const session = sessions.get(credential);
  if (!session) throw new SessionError("SESSION_REQUIRED", "세션이 만료되었습니다. 새 세션을 시작하세요.", 401);
  const nonce = randomBytes(32).toString("base64url");
  session.releases.set(tabId, { nonce, releaseToken, claimed: false });
  return nonce;
}

export function claimTabRelease(credential: string, tabId: string, nonce: string): string {
  const session = sessions.get(credential);
  const release = session?.releases.get(tabId);
  if (!release || release.claimed || release.nonce !== nonce) {
    throw new SessionError("RELEASE_NONCE_INVALID", "탭 종료 토큰이 유효하지 않습니다.", 403);
  }
  release.claimed = true;
  return release.releaseToken;
}

export function deleteSession(credential: string): void {
  sessions.delete(credential);
}

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? PROD_COOKIE : DEV_COOKIE;
}

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
