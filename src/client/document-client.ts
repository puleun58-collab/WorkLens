import type { WorkerEnvelope, WorkerFailure, WorkerRequest, WorkerResultMap } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: WorkerFailure) => void };

let worker: Worker | undefined;
const pending = new Map<string, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./document-worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("message", (event: MessageEvent<WorkerEnvelope>) => {
    const envelope = event.data;
    const entry = pending.get(envelope.id);
    if (!entry) return;
    pending.delete(envelope.id);
    if (envelope.ok) entry.resolve(envelope.data);
    else entry.reject(envelope.error);
  });
  created.addEventListener("error", () => {
    for (const entry of pending.values()) {
      entry.reject({ code: "WORKER_FAILED", message: "문서 처리기를 실행하지 못했습니다. 페이지를 새로고침하세요." });
    }
    pending.clear();
    worker?.terminate();
    worker = undefined;
  });
  worker = created;
  return created;
}

/** Sends one request to the in-browser document worker and awaits its reply. */
export function runInWorker<K extends WorkerRequest["kind"]>(
  request: Extract<WorkerRequest, { kind: K }>,
  transfer: Transferable[] = [],
): Promise<WorkerResultMap[K]> {
  const id = crypto.randomUUID();
  const target = ensureWorker();
  return new Promise<WorkerResultMap[K]>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    target.postMessage({ id, request }, transfer);
  });
}

/** Destroys the worker so every parsed document and file byte is released. */
export function disposeWorkspace(): void {
  for (const entry of pending.values()) {
    entry.reject({ code: "WORKSPACE_CLEARED", message: "작업 공간을 비웠습니다." });
  }
  pending.clear();
  worker?.terminate();
  worker = undefined;
}
