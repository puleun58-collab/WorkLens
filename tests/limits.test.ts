import { describe, expect, it } from "vitest";
import { assertResultWithinLimit, readBoundedJson, runBoundedOperation } from "@/server/http";

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
    await expect(readBoundedJson(request)).rejects.toMatchObject({
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
    expect(() => assertResultWithinLimit({ findings: [{ code: "empty-cell" }] })).not.toThrow();
  });

  it("refuses a result that would amplify beyond the response ceiling", () => {
    const huge = { findings: Array.from({ length: 400_000 }, (_, index) => ({
      code: "duplicate-value",
      message: `finding ${index} with enough text to exceed the serialization ceiling`,
    })) };
    expect(() => assertResultWithinLimit(huge)).toThrow(/RESULT_TOO_LARGE|결과가 너무/);
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
});
