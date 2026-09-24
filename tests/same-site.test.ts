import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, requireSameSite } from "@/server/http";

const call = (url: string, origin?: string) => new Request(url, { method: "POST", headers: origin ? { Origin: origin } : {} });

function code(url: string, origin?: string): string | null {
  try {
    requireSameSite(call(url, origin));
    return null;
  } catch (error) {
    return error instanceof ApiError ? error.code : "UNEXPECTED";
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("same-site origin check", () => {
  it("in development treats exactly localhost and 127.0.0.1 on the same port as one origin", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(code("http://localhost:3000/api/law", "http://localhost:3000")).toBeNull();
    expect(code("http://localhost:3000/api/law", "http://127.0.0.1:3000")).toBeNull();
    expect(code("http://127.0.0.1:3000/api/law", "http://localhost:3000")).toBeNull();
    for (const origin of [
      "http://127.0.0.1:4000", "https://127.0.0.1:3000", "http://localhost.evil.example:3000", "http://127.0.0.1.evil.example:3000",
      "https://evil.example", "http://[::1]:3000", "http://127.0.0.1:3000/path", "not a url",
    ]) {
      expect(code("http://localhost:3000/api/law", origin), origin).toBe("ORIGIN_MISMATCH");
    }
    expect(code("https://worklens.test/api/law", "http://localhost:3000")).toBe("ORIGIN_MISMATCH");
    expect(code("http://localhost:3000/api/law")).toBe("ORIGIN_REQUIRED");
  });

  it("outside development applies no loopback exception", () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(code("https://worklens.test/api/law", "https://worklens.test")).toBeNull();
      expect(code("http://localhost:3000/api/law", "http://127.0.0.1:3000")).toBe("ORIGIN_MISMATCH");
      expect(code("https://worklens.test/api/law", "http://localhost")).toBe("ORIGIN_MISMATCH");
      expect(code("https://worklens.test/api/law", "https://worklens.test.evil.com")).toBe("ORIGIN_MISMATCH");
    }
  });

  it("still rejects explicit cross-site fetch metadata", () => {
    vi.stubEnv("NODE_ENV", "development");
    const request = new Request("http://localhost:3000/api/law", { method: "POST", headers: { Origin: "http://localhost:3000", "Sec-Fetch-Site": "cross-site" } });
    expect(() => requireSameSite(request)).toThrow(expect.objectContaining({ code: "CROSS_SITE_REQUEST" }));
  });
});
