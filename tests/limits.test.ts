import { describe, expect, it, vi } from "vitest";
import { ok, OPERATION_LEASE_MS, readBoundedJson, runBoundedOperation } from "@/server/http";

const jsonRequest = (body: string, headers: Record<string, string> = {}): Request =>
  new Request("https://worklens.internal/api/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("bounded request bodies", () => {
  it("parses a normal control-plane body", async () => {
    await expect(readBoundedJson(jsonRequest(JSON.stringify({ fileIds: ["a"] })))).resolves.toEqual({
      fileIds: ["a"],
    });
  });

  it("rejects an oversized body declared by content-length before allocating", async () => {
    const request = jsonRequest("{}", { "content-length": String(10 * 1024 * 1024) });
    await expect(readBoundedJson(request)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects an oversized streamed body that hides its length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 16; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("https://worklens.internal/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required for a streaming request body in Node.
      duplex: "half",
    });
    await expect(readBoundedJson(request, 64 * 1024)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    await expect(readBoundedJson(jsonRequest("not-json"))).resolves.toBeNull();
  });
});

describe("operation result ceiling", () => {
  it("allows a normal result", () => {
    expect(() => ok({ findings: [{ code: "empty-cell" }] })).not.toThrow();
  });

  it("refuses a result that would amplify beyond the response ceiling", () => {
    const huge = { findings: Array.from({ length: 400_000 }, (_, index) => ({
      code: "duplicate-value",
      message: `finding ${index} with enough text to exceed the serialization ceiling`,
    })) };
    expect(() => ok(huge)).toThrow(/RESULT_TOO_LARGE|결과가 너무/);
  });

  it.each(["a", "한", "😀", "\ud800"])("preserves the exact UTF-8 ceiling for %j", (unit) => {
    const limit = 4 * 1024 * 1024;
    const encodedUnit = JSON.stringify(unit).slice(1, -1);
    const unitBytes = new TextEncoder().encode(encodedUnit).byteLength;
    const count = Math.floor((limit - 2) / unitBytes);
    const padding = "a".repeat(limit - 2 - count * unitBytes);
    const exact = unit.repeat(count) + padding;
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(limit);
    expect(() => ok(exact)).not.toThrow();
    expect(() => ok(exact + "a")).toThrow(/결과가 너무/);
  });

  it("preserves the consumer JSON, evidence fields and response headers", async () => {
    const data = {
      text: "공식 본문 😀",
      evidence: { status: "partial", articles: [{ law: "민법", jo: "제544조", currency: "current", stage: "chain" }] },
      optional: undefined,
      exceptional: Number.NaN,
    };
    const result = await runBoundedOperation(() => data);
    const response = ok(result, 201, "cpu-contract");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(JSON.stringify({ data, requestId: "cpu-contract" }));
  });

  it("admits at most four concurrent derived operations", async () => {
    const releases: Array<() => void> = [];
    const held = Array.from({ length: 4 }, () =>
      runBoundedOperation(() => new Promise<string>((resolve) => releases.push(() => resolve("done")))),
    );
    await expect(runBoundedOperation(async () => "overflow")).rejects.toMatchObject({
      code: "OPERATION_CAPACITY",
      status: 429,
    });
    for (const release of releases) release();
    await expect(Promise.all(held)).resolves.toEqual(["done", "done", "done", "done"]);
  });

  it("returns the slot of a failed operation immediately", async () => {
    for (let index = 0; index < 6; index += 1) {
      await expect(runBoundedOperation(async () => { throw new Error("upstream down"); })).rejects.toThrow("upstream down");
    }
    await expect(runBoundedOperation(async () => "after failures")).resolves.toBe("after failures");
  });

  it("reclaims slots whose invocation was terminated without settling, but only after the lease", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    try {
      // A platform-terminated invocation never resolves, rejects or runs `finally`.
      for (let index = 0; index < 4; index += 1) void runBoundedOperation(() => new Promise<never>(() => undefined));
      clock.mockReturnValue(started + OPERATION_LEASE_MS - 1);
      await expect(runBoundedOperation(async () => "too early")).rejects.toMatchObject({ code: "OPERATION_CAPACITY", status: 429 });
      clock.mockReturnValue(started + OPERATION_LEASE_MS);
      await expect(runBoundedOperation(async () => "recovered")).resolves.toBe("recovered");
    } finally {
      clock.mockRestore();
    }
  });

  it("does not replay a terminated operation when reclaiming its lease or retrying capacity", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const terminated = vi.fn(() => new Promise<never>(() => undefined));
    const retry = vi.fn(async () => "recovered");
    try {
      for (let index = 0; index < 4; index += 1) void runBoundedOperation(terminated);
      await expect(runBoundedOperation(retry)).rejects.toMatchObject({ code: "OPERATION_CAPACITY" });
      expect(retry).not.toHaveBeenCalled();
      clock.mockReturnValue(started + OPERATION_LEASE_MS);
      await expect(runBoundedOperation(retry)).resolves.toBe("recovered");
      expect(terminated).toHaveBeenCalledTimes(4);
      expect(retry).toHaveBeenCalledTimes(1);
      await expect(runBoundedOperation(async () => { throw new Error("upstream failure"); })).rejects.toThrow("upstream failure");
      await expect(runBoundedOperation(async () => "healthy")).resolves.toBe("healthy");
    } finally {
      clock.mockRestore();
    }
  });
});
