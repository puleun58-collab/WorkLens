import { parseDocument, type ParseDocumentInput } from "./index";
import { Socket } from "node:net";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

type RunnerMessage = Omit<ParseDocumentInput, "bytes"> & { bytes?: string; filePath?: string; size?: number };

Object.defineProperty(Socket.prototype, "connect", {
  configurable: false,
  value() {
    throw new Error("PARSER_NETWORK_DISABLED");
  },
});
Object.defineProperty(dgram, "createSocket", {
  configurable: false,
  value() {
    throw new Error("PARSER_NETWORK_DISABLED");
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: false,
  value() {
    throw new Error("PARSER_NETWORK_DISABLED");
  },
});

process.once("message", async (message: RunnerMessage) => {
  try {
    const delay = /^__worklens_test_delay_(\d+)\.csv$/.exec(message.fileName);
    if (process.env.NODE_ENV === "test" && delay) {
      await new Promise((resolve) => setTimeout(resolve, Number(delay[1])));
    }
    let bytes: Uint8Array;
    if (message.bytes !== undefined) {
      bytes = Uint8Array.from(Buffer.from(message.bytes, "base64"));
    } else {
      const root = path.resolve(process.env.WORKLENS_TEMP_DIR ?? ".worklens-tmp");
      const filePath = path.resolve(message.filePath ?? "");
      if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error("PARSER_PATH_INVALID");
      bytes = new Uint8Array(await readFile(filePath));
      if (bytes.byteLength !== message.size) throw new Error("PARSER_FILE_CHANGED");
    }
    const input: ParseDocumentInput = {
      fileId: message.fileId,
      fileName: message.fileName,
      bytes,
    };
    const document = await parseDocument(input);
    const normalizedSize = Buffer.byteLength(JSON.stringify(document));
    const serialized = JSON.stringify({ ok: true, document, normalizedSize });
    if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) throw new Error("PARSER_OUTPUT_LIMIT");
    process.send?.(serialized, () => process.exit(0));
  } catch (error) {
    const message =
      error instanceof Error && /^(PARSER_|CSV_|파일을 읽을 수 없습니다)/.test(error.message)
        ? error.message
        : "PARSER_FAILED";
    process.send?.(JSON.stringify({ ok: false, error: message.slice(0, 200) }), () => process.exit(1));
  }
});

setTimeout(() => process.exit(1), 119_000).unref();
