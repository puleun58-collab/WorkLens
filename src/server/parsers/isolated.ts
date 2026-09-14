import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { NormalizedDocument } from "@/domain/document";
import type { FileKind } from "@/domain/document";
import { parseDocument, type ParseDocumentInput } from "./index";

const WALL_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024 + 1024;
const MAX_CONCURRENT_PARSERS = 2;
const MAX_WAITING_PARSERS = 8;
const MAX_ADMITTED_BYTES = 200 * 1024 * 1024;
let activeParsers = 0;
let admittedBytes = 0;
const parserWaiters: Array<{ bytes: number; resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];

type RunnerResult = { ok: true; document: NormalizedDocument; normalizedSize: number } | { ok: false; error: string };
type IsolatedParseInput =
  | ParseDocumentInput
  | (Omit<ParseDocumentInput, "bytes"> & { filePath: string; size: number; contentHash?: string });

export async function parseDocumentIsolated(
  input: IsolatedParseInput,
  signal?: AbortSignal,
  wallTimeoutMsOverride?: number,
): Promise<{ document: NormalizedDocument; normalizedSize: number }> {
  const inputBytes = "bytes" in input ? input.bytes.byteLength : input.size;
  await acquireParserSlot(inputBytes, signal);
  const isCloudflareWorker = "WebSocketPair" in globalThis;
  if (
    process.env.WORKLENS_PARSER_MODE === "in-process" ||
    process.env.WORKLENS_CLOUDFLARE === "true" ||
    isCloudflareWorker
  ) {
    try {
      if (signal?.aborted) throw new Error("PARSER_CANCELLED");
      const bytes = "bytes" in input ? input.bytes : new Uint8Array(await readFile(input.filePath));
      const document = await parseDocument({ fileId: input.fileId, fileName: input.fileName, bytes });
      const normalizedSize = Buffer.byteLength(JSON.stringify(document));
      if (normalizedSize > MAX_MESSAGE_BYTES) throw new Error("PARSER_OUTPUT_LIMIT");
      return { document, normalizedSize };
    } finally {
      releaseParserSlot(inputBytes);
    }
  }
  const runner = path.join(/* turbopackIgnore: true */ process.cwd(), ".worklens", "parser-runner.mjs");
  const tempRoot = path.resolve(
    /* turbopackIgnore: true */ process.env.WORKLENS_TEMP_DIR ?? path.join(os.tmpdir(), "worklens-v1"),
  );
  const uploadDirectory = "filePath" in input ? path.dirname(path.resolve(input.filePath)) : undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const release = () => releaseParserSlot(inputBytes);
    try {
      child = fork(runner, [], {
        execArgv: [
          "--max-old-space-size=1024",
          "--permission",
          `--allow-fs-read=${path.join(process.cwd(), ".worklens")}`,
          ...(uploadDirectory ? [`--allow-fs-read=${uploadDirectory}`] : []),
        ],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV,
          NO_PROXY: "*",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          WORKLENS_TEMP_DIR: tempRoot,
        },
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("PARSER_CANCELLED")));
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.connected) child.disconnect();
      release();
      callback();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`PARSER_LIMIT: parsing exceeded ${wallTimeoutMsOverride ?? WALL_TIMEOUT_MS} ms`)));
    }, wallTimeoutMsOverride ?? WALL_TIMEOUT_MS);
    child.once("message", (raw) => {
      if (settled) return;
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("PARSER_OUTPUT_LIMIT")));
        return;
      }
      try {
        const result = JSON.parse(raw) as RunnerResult;
        const contentHash = "bytes" in input
          ? createHash("sha256").update(input.bytes).digest("hex")
          : "contentHash" in input && typeof input.contentHash === "string"
            ? input.contentHash
            : undefined;
        const expectedVersion = contentHash
          ? createHash("sha256").update(`worklens-parser-v2\0${contentHash}`).digest("hex")
          : undefined;
        const expected = {
          fileId: input.fileId,
          fileName: input.fileName,
          kind: path.extname(input.fileName).slice(1).toLowerCase() as FileKind,
          documentVersion: expectedVersion ?? "",
        };
        if (result.ok && isRunnerDocument(result.document, result.normalizedSize, expected)) {
          finish(() => resolve({ document: result.document, normalizedSize: result.normalizedSize }));
        }
        else if (result.ok) {
          child.kill("SIGKILL");
          finish(() => reject(new Error("PARSER_OUTPUT_INVALID")));
        }
        else finish(() => reject(new Error(result.error)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!settled) finish(() => reject(new Error(`PARSER_RUNNER_EXIT_${code ?? "UNKNOWN"}`)));
    });
    child.send("bytes" in input
      ? { ...input, bytes: Buffer.from(input.bytes).toString("base64") }
      : input);
  });
}

export function isRunnerDocument(
  document: unknown,
  normalizedSize: unknown,
  expected: { fileId: string; fileName: string; kind: FileKind; documentVersion?: string },
): document is NormalizedDocument {
  if (
    typeof normalizedSize !== "number" ||
    !Number.isSafeInteger(normalizedSize) ||
    normalizedSize <= 0 ||
    normalizedSize > MAX_MESSAGE_BYTES ||
    typeof document !== "object" ||
    document === null
  ) return false;
  const candidate = document as Partial<NormalizedDocument>;
  const actualSize = Buffer.byteLength(JSON.stringify(document));
  const validOptionalString = (value: unknown, max: number): boolean =>
    value === undefined || (typeof value === "string" && value.length <= max);
  const validOptionalInteger = (value: unknown): boolean =>
    value === undefined || (Number.isSafeInteger(value) && Number(value) > 0);
  const metadata = candidate.metadata as Record<string, unknown> | undefined;
  if (
    normalizedSize !== actualSize ||
    typeof candidate.id !== "string" ||
    typeof candidate.fileId !== "string" ||
    candidate.fileId !== expected.fileId ||
    candidate.id !== `document:${expected.fileId}` ||
    typeof candidate.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.version) ||
    (expected.documentVersion !== undefined && candidate.version !== expected.documentVersion) ||
    candidate.parserRevision !== "worklens-parser-v2" ||
    candidate.kind !== expected.kind ||
    typeof metadata !== "object" ||
    metadata === null ||
    typeof metadata.fileName !== "string" ||
    metadata.fileName.length === 0 ||
    metadata.fileName !== expected.fileName ||
    metadata.fileName.length > 512 ||
    !validOptionalInteger(metadata.pageCount) ||
    (metadata.sheets !== undefined && (
      !Array.isArray(metadata.sheets) ||
      metadata.sheets.length > 1_000 ||
      !metadata.sheets.every((sheet) =>
        typeof sheet === "object" &&
        sheet !== null &&
        typeof sheet.name === "string" &&
        ["visible", "hidden", "veryHidden"].includes(String(sheet.visibility)) &&
        Number.isSafeInteger(sheet.rowCount) &&
        Number.isSafeInteger(sheet.columnCount),
      )
    )) ||
    !Array.isArray(candidate.blocks) ||
    !Array.isArray(candidate.warnings) ||
    candidate.warnings.length > 100 ||
    !candidate.warnings.every((warning) => typeof warning === "string" && /^[A-Z0-9_]{1,100}$/.test(warning)) ||
    candidate.blocks.length > 100_000
  ) return false;
  const validSource = (source: unknown): boolean => {
    if (typeof source !== "object" || source === null) return false;
    const candidateSource = source as Record<string, unknown>;
    return (
      candidateSource.fileId === expected.fileId &&
      candidateSource.documentId === candidate.id &&
      candidateSource.documentVersion === candidate.version &&
      typeof candidateSource.nodeId === "string" &&
      candidateSource.nodeId.length > 0 && candidateSource.nodeId.length <= 512 &&
      typeof candidateSource.label === "string" &&
      candidateSource.label.length > 0 && candidateSource.label.length <= 1_000 &&
      validOptionalInteger(candidateSource.page) &&
      validOptionalInteger(candidateSource.row) &&
      validOptionalInteger(candidateSource.column) &&
      validOptionalString(candidateSource.sheet, 512) &&
      validOptionalString(candidateSource.cellRange, 128) &&
      validOptionalString(candidateSource.quote, 1_000_000) &&
      typeof candidateSource.quoteHash === "string" &&
      candidateSource.quoteHash === createHash("sha256")
        .update(typeof candidateSource.quote === "string" ? candidateSource.quote : "")
        .digest("hex")
    );
  };
  return candidate.blocks.every((block) => {
    if (typeof block !== "object" || block === null || !("type" in block) || !("source" in block)) return false;
    if (!validSource(block.source)) return false;
    if (
      typeof block.id !== "string" ||
      block.id.length === 0 ||
      block.id.length > 512 ||
      block.source.nodeId !== block.id
    ) return false;
    if (block.type === "paragraph") {
      return (
        typeof block.text === "string" &&
        block.text.length <= 1_000_000 &&
        (block.role === undefined || block.role === "paragraph" || block.role === "heading") &&
        validOptionalInteger(block.headingLevel)
      );
    }
    if (block.type !== "table" || !Array.isArray(block.rows) || block.rows.length > 100_000) return false;
    return block.rows.every((row) =>
      Array.isArray(row) &&
      row.length <= 1_000 &&
      row.every((cell) =>
        typeof cell === "object" &&
        cell !== null &&
        typeof cell.display === "string" &&
        cell.display.length <= 1_000_000 &&
        (cell.value === null || ["string", "number", "boolean"].includes(typeof cell.value)) &&
        (typeof cell.value !== "number" || Number.isFinite(cell.value)) &&
        validOptionalInteger(cell.rowSpan) &&
        validOptionalInteger(cell.colSpan) &&
        validSource(cell.source),
      ),
    );
  });
}

async function acquireParserSlot(bytes: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("PARSER_CANCELLED");
  if (admittedBytes + bytes > MAX_ADMITTED_BYTES || parserWaiters.length >= MAX_WAITING_PARSERS) {
    throw new Error("PARSER_CAPACITY");
  }
  admittedBytes += bytes;
  if (activeParsers < MAX_CONCURRENT_PARSERS) {
    activeParsers += 1;
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = parserWaiters.indexOf(waiter);
        if (index >= 0) parserWaiters.splice(index, 1);
        admittedBytes -= bytes;
        reject(new Error("PARSER_CANCELLED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const waiter: (typeof parserWaiters)[number] = {
        bytes,
        reject,
        signal,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      parserWaiters.push(waiter);
    });
    activeParsers += 1;
  } catch (error) {
    throw error;
  }
}

function releaseParserSlot(bytes: number): void {
  activeParsers -= 1;
  admittedBytes -= bytes;
  parserWaiters.shift()?.resolve();
}

export function parserAdmissionSnapshot(): { active: number; waiting: number; admittedBytes: number } {
  return { active: activeParsers, waiting: parserWaiters.length, admittedBytes };
}
