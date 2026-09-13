import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isRunnerDocument, parseDocumentIsolated, parserAdmissionSnapshot } from "@/server/parsers/isolated";

const execFileAsync = promisify(execFile);
const csvBytes = () => new TextEncoder().encode("name,amount\nSeoul,123\n");

beforeAll(async () => {
  await expect(readFile(path.join(process.cwd(), ".worklens", "parser-runner.mjs"))).resolves.toBeDefined();
  await expect(readFile(path.join(process.cwd(), ".worklens", "parser-sandbox-probe.mjs"))).resolves.toBeDefined();
});

describe("isolated parser boundary", () => {
  it("normalizes valid input through the restricted child", async () => {
    const result = await parseDocumentIsolated({ fileId: "file-1", fileName: "sample.csv", bytes: csvBytes() });
    expect(result.document).toMatchObject({ kind: "csv", fileId: "file-1" });
    expect(result.normalizedSize).toBeGreaterThan(0);
  });

  it("returns a bounded failure for malformed input and reaps the child", async () => {
    await expect(parseDocumentIsolated({
      fileId: "file-2",
      fileName: "broken.csv",
      bytes: Uint8Array.from([0xff, 0xfe]),
    })).rejects.toThrow(/읽을 수 없습니다|PARSER/);
  });

  it("rejects forged child size and provenance at the IPC trust boundary", () => {
    const quote = "sensitive";
    const version = "a".repeat(64);
    const forged = {
      id: "document:file-1",
      fileId: "file-1",
      kind: "csv",
      version,
      parserRevision: "worklens-parser-v2",
      metadata: { fileName: "sample.csv" },
      warnings: [],
      blocks: [{
        type: "paragraph",
        id: "p1",
        text: quote,
        source: {
          fileId: "other-file",
          documentId: "document:file-1",
          documentVersion: version,
          nodeId: "p1",
          label: "Paragraph",
          quote,
          quoteHash: createHash("sha256").update(quote).digest("hex"),
        },
      }],
    };
    const size = Buffer.byteLength(JSON.stringify(forged));
    const expected = { fileId: "file-1", fileName: "sample.csv", kind: "csv" as const, documentVersion: version };
    expect(isRunnerDocument(forged, size, expected)).toBe(false);
    forged.blocks[0].source.fileId = "file-1";
    expect(isRunnerDocument(forged, size - 1, expected)).toBe(false);
    expect(isRunnerDocument(forged, Buffer.byteLength(JSON.stringify(forged)), expected)).toBe(true);
  });

  it("kills and reaps a timed-out child", async () => {
    await expect(parseDocumentIsolated({
      fileId: "timeout",
      fileName: "__worklens_test_delay_500.csv",
      bytes: csvBytes(),
    }, undefined, 30)).rejects.toThrow("PARSER_LIMIT");
    await expect(parseDocumentIsolated({ fileId: "after-timeout", fileName: "after.csv", bytes: csvBytes() }))
      .resolves.toMatchObject({ document: { kind: "csv" } });
  });

  it("kills a child on cancellation and returns its slot", async () => {
    const controller = new AbortController();
    const pending = parseDocumentIsolated({
      fileId: "cancel",
      fileName: "__worklens_test_delay_500.csv",
      bytes: csvBytes(),
    }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow("PARSER_CANCELLED");
    await expect(parseDocumentIsolated({ fileId: "after-cancel", fileName: "after.csv", bytes: csvBytes() }))
      .resolves.toMatchObject({ document: { kind: "csv" } });
  });

  it("rejects normalized IPC output above the 20 MiB ceiling before parent parsing", async () => {
    const rows = Array.from({ length: 90_000 }, (_, index) => `row-${index},value-${index}`).join("\n");
    await expect(parseDocumentIsolated({
      fileId: "oversized-output",
      fileName: "oversized.csv",
      bytes: new TextEncoder().encode(`name,value\n${rows}\n`),
    })).rejects.toThrow("PARSER_OUTPUT_LIMIT");
  }, 30_000);

  it("admits only two active children and serializes a third", async () => {
    const pending = [
      parseDocumentIsolated({ fileId: "one", fileName: "__worklens_test_delay_120.csv", bytes: csvBytes() }),
      parseDocumentIsolated({ fileId: "two", fileName: "__worklens_test_delay_120.csv", bytes: csvBytes() }),
      parseDocumentIsolated({ fileId: "three", fileName: "__worklens_test_delay_120.csv", bytes: csvBytes() }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(parserAdmissionSnapshot()).toMatchObject({ active: 2, waiting: 1 });
    await Promise.all(pending);
    expect(parserAdmissionSnapshot()).toEqual({ active: 0, waiting: 0, admittedBytes: 0 });
  });

  it("removes an aborted queued parser without leaking its byte reservation", async () => {
    const first = parseDocumentIsolated({ fileId: "held-1", fileName: "__worklens_test_delay_200.csv", bytes: csvBytes() });
    const second = parseDocumentIsolated({ fileId: "held-2", fileName: "__worklens_test_delay_200.csv", bytes: csvBytes() });
    const controller = new AbortController();
    const queued = parseDocumentIsolated(
      { fileId: "queued", fileName: "__worklens_test_delay_200.csv", bytes: csvBytes() },
      controller.signal,
    );
    controller.abort();
    await expect(queued).rejects.toThrow("PARSER_CANCELLED");
    await Promise.all([first, second]);
    await expect(parseDocumentIsolated({ fileId: "after-queued-abort", fileName: "after.csv", bytes: csvBytes() }))
      .resolves.toMatchObject({ document: { kind: "csv" } });
    expect(parserAdmissionSnapshot()).toEqual({ active: 0, waiting: 0, admittedBytes: 0 });
  });

  it.each(["fs-write", "fs-read-repository", "child-process", "tcp", "udp", "fetch"])(
    "denies %s from the parser sandbox",
    async (probe) => {
      const runner = path.join(process.cwd(), ".worklens", "parser-sandbox-probe.mjs");
      try {
        await execFileAsync(process.execPath, [
          "--permission",
          `--allow-fs-read=${path.join(process.cwd(), ".worklens")}`,
          runner,
          probe,
        ]);
        throw new Error("sandbox probe unexpectedly succeeded");
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        expect(failure.code).toBe(1);
        expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).not.toContain("UNEXPECTED_SUCCESS");
        expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).toMatch(/restricted|PARSER_NETWORK_DISABLED|denied/i);
      }
    },
  );
});
