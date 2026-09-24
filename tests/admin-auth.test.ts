import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminSession, hasAdminSession, requireAdmin } from "@/server/admin-auth";

let ip = 0;
const request = (headers: Record<string, string> = {}) => new Request("https://worklens.test/api/admin/login", { headers });
const client = () => ({ "cf-connecting-ip": `10.0.0.${++ip}` });
const withCookie = (setCookie: string) => request({ cookie: `other=1; ${setCookie.split(";")[0]}` });

beforeEach(() => {
  process.env.WORKLENS_ADMIN_PASSWORD = "correct horse";
  process.env.WORKLENS_ADMIN_SESSION_SECRET = "session-secret";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORKLENS_ADMIN_PASSWORD;
  delete process.env.WORKLENS_ADMIN_SESSION_SECRET;
});

describe("admin session", () => {
  it("issues a hardened cookie that authenticates until it expires", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") });
    const cookie = await createAdminSession(request(client()), "correct horse");
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=14400$/);
    expect(await hasAdminSession(withCookie(cookie))).toBe(true);
    await expect(requireAdmin(withCookie(cookie))).resolves.toBeUndefined();
    vi.setSystemTime(new Date("2026-09-24T04:00:01Z"));
    expect(await hasAdminSession(withCookie(cookie))).toBe(false);
  });

  it("rejects missing, unsigned, tampered and foreign-secret cookies", async () => {
    const cookie = await createAdminSession(request(client()), "correct horse");
    const token = cookie.split(";")[0].split("=").slice(1).join("=");
    expect(await hasAdminSession(request())).toBe(false);
    expect(await hasAdminSession(request({ cookie: "worklens_admin=nodot" }))).toBe(false);
    expect(await hasAdminSession(request({ cookie: `worklens_admin=admin.99999999999.${token.split(".")[2]}` }))).toBe(false);
    process.env.WORKLENS_ADMIN_SESSION_SECRET = "rotated";
    expect(await hasAdminSession(withCookie(cookie))).toBe(false);
    delete process.env.WORKLENS_ADMIN_SESSION_SECRET;
    expect(await hasAdminSession(withCookie(cookie))).toBe(false);
    await expect(requireAdmin(request())).rejects.toMatchObject({ code: "ADMIN_UNAUTHORIZED", status: 401 });
  });

  it("locks a client out after five wrong passwords without affecting others", async () => {
    const attacker = client();
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(createAdminSession(request(attacker), "wrong")).rejects.toMatchObject({ code: "INVALID_PASSWORD", status: 401 });
    }
    await expect(createAdminSession(request(attacker), "correct horse")).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS", status: 429 });
    await expect(createAdminSession(request(client()), "correct horse")).resolves.toContain("worklens_admin=");
  });

  it("refuses to sign in when the password or session secret is not configured", async () => {
    delete process.env.WORKLENS_ADMIN_SESSION_SECRET;
    await expect(createAdminSession(request(client()), "correct horse")).rejects.toMatchObject({ code: "ADMIN_NOT_CONFIGURED", status: 503 });
  });
});
