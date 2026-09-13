import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FileKind, NormalizedDocument } from "@/domain/document";
import type { ComparisonResult } from "@/domain/compare";
import {
  assertFenceOwner,
  assertLocalEphemeralAdapterAllowed,
  type EphemeralFence,
} from "@/server/ephemeral-adapter";
import { SESSION_TTL_MS } from "@/server/session";

const ROOT = path.resolve(/* turbopackIgnore: true */ process.env.WORKLENS_TEMP_DIR ?? path.join(os.tmpdir(), "worklens-v1"));
const EXPIRY_MARKER = ".expires-at";
const SWEEP_INTERVAL_MS = Math.min(60_000, Math.max(1_000, Math.floor(SESSION_TTL_MS / 4)));
const MAX_FILES_PER_WORKSPACE = 10;
const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;
const MAX_NORMALIZED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_NORMALIZED_WORKSPACE_BYTES = 100 * 1024 * 1024;
// Anonymous callers can mint unlimited principals, so per-workspace ceilings alone
// do not bound this process. These are the adapter-wide admission limits.
const MAX_WORKSPACES = 50;
const MAX_PROCESS_BYTES = 200 * 1024 * 1024;
const MAX_PROCESS_NORMALIZED_BYTES = 200 * 1024 * 1024;
const MAX_LIVE_TABS_PER_WORKSPACE = 20;
let removePath: typeof rm = rm;

export type { FileKind } from "@/domain/document";

export type FileSummary = {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  status: "ready";
  metadata: NormalizedDocument["metadata"];
  warnings: NormalizedDocument["warnings"];
};

type FileRecord = FileSummary & {
  path: string;
  document: NormalizedDocument;
  normalizedSize: number;
};

type Workspace = {
  principalKey: string;
  generation: string;
  fence: number;
  committedExpiresAt: number;
  tombstonedAt?: number;
  files: Map<string, FileRecord>;
  deleteTimer?: ReturnType<typeof setTimeout>;
  tabs: Map<string, { token: string; expiresAt: number; released: boolean }>;
  pendingUploads: Map<string, number>;
  pendingCleanup: Map<string, string>;
};

const globalState = globalThis as typeof globalThis & {
  __worklensWorkspaces?: Map<string, Workspace>;
  __worklensCleanupStarted?: boolean;
};

const workspaces = globalState.__worklensWorkspaces ?? new Map<string, Workspace>();
globalState.__worklensWorkspaces = workspaces;

export class WorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function assertLocalAdapterAllowed(): void {
  try {
    assertLocalEphemeralAdapterAllowed();
  } catch {
    throw new WorkspaceError(
      "LOCAL_ADAPTER_DISABLED",
      "단일 프로세스 임시 저장소는 production에서 비활성화되어 있습니다.",
      503,
    );
  }
}

function workspaceDir(principalKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(principalKey)) {
    throw new WorkspaceError("SESSION_INVALID", "세션 식별자가 유효하지 않습니다.", 401);
  }
  return path.join(ROOT, principalKey);
}

async function writeExpiryMarker(workspace: Workspace): Promise<void> {
  const dir = workspaceDir(workspace.principalKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, EXPIRY_MARKER), String(workspace.committedExpiresAt), { encoding: "utf8", mode: 0o600 });
}

async function touch(workspace: Workspace, now = Date.now()): Promise<void> {
  workspace.committedExpiresAt = now + SESSION_TTL_MS;
  await writeExpiryMarker(workspace);
}

function workspaceFence(workspace: Workspace): EphemeralFence {
  return {
    principalKey: workspace.principalKey,
    generation: workspace.generation,
    fence: workspace.fence,
    committedExpiresAt: workspace.committedExpiresAt,
    tombstonedAt: workspace.tombstonedAt,
  };
}

function assertWorkspaceOwner(workspace: Workspace, principalKey: string): void {
  try {
    assertFenceOwner(workspaceFence(workspace), {
      principalKey,
      generation: workspace.generation,
    });
  } catch {
    throw new WorkspaceError("SESSION_EXPIRED", "세션 데이터가 없거나 만료되었습니다. 새 세션을 시작하세요.", 410);
  }
}

export async function getWorkspace(principalKey: string, renew = true, cancelPending = true): Promise<Workspace> {
  assertLocalAdapterAllowed();
  await sweepExpired();
  const existing = workspaces.get(principalKey);
  if (!existing) {
    throw new WorkspaceError("SESSION_EXPIRED", "세션 데이터가 없거나 만료되었습니다. 새 세션을 시작하세요.", 410);
  }
  if (existing.committedExpiresAt <= Date.now()) {
    await deleteWorkspace(principalKey);
    throw new WorkspaceError("SESSION_EXPIRED", "세션이 만료되어 임시 데이터가 삭제되었습니다.", 410);
  }
  assertWorkspaceOwner(existing, principalKey);
  await retryPendingCleanup(existing);
  if (cancelPending && existing.deleteTimer) {
    clearTimeout(existing.deleteTimer);
    existing.deleteTimer = undefined;
  }
  if (renew) await touch(existing);
  return existing;
}

export async function createWorkspace(principalKey: string): Promise<Workspace> {
  assertLocalAdapterAllowed();
  await sweepExpired();
  const existing = workspaces.get(principalKey);
  if (existing && existing.tombstonedAt === undefined && existing.committedExpiresAt > Date.now()) {
    if (existing.deleteTimer) {
      clearTimeout(existing.deleteTimer);
      existing.deleteTimer = undefined;
    }
    await touch(existing);
    return existing;
  }
  if (existing) await deleteWorkspace(principalKey);
  if (workspaces.size >= MAX_WORKSPACES) {
    throw new WorkspaceError("SERVER_AT_CAPACITY", "동시 세션 수가 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 503);
  }
  const committedExpiresAt = Date.now() + SESSION_TTL_MS;
  const workspace: Workspace = {
    principalKey,
    generation: randomUUID(),
    fence: 0,
    committedExpiresAt,
    files: new Map(),
    tabs: new Map(),
    pendingUploads: new Map(),
    pendingCleanup: new Map(),
  };
  workspaces.set(principalKey, workspace);
  await writeExpiryMarker(workspace);
  return workspace;
}

export async function allocateUpload(principalKey: string, extension: FileKind): Promise<{ id: string; filePath: string }> {
  const workspace = await getWorkspace(principalKey);
  if (workspace.files.size + workspace.pendingUploads.size >= MAX_FILES_PER_WORKSPACE) {
    throw new WorkspaceError("WORKSPACE_FILE_LIMIT", "세션에는 최대 10개 파일만 보관할 수 있습니다.", 413);
  }
  const id = randomUUID();
  workspace.pendingUploads.set(id, 0);
  const filePath = path.join(/* turbopackIgnore: true */ workspaceDir(principalKey), `${id}.${extension}`);
  return { id, filePath };
}

export async function reserveUploadBytes(principalKey: string, id: string, size: number): Promise<void> {
  const workspace = await getWorkspace(principalKey);
  if (!workspace.pendingUploads.has(id) || !Number.isSafeInteger(size) || size < 0) {
    throw new WorkspaceError("UPLOAD_RESERVATION_INVALID", "업로드 예약이 유효하지 않습니다.", 409);
  }
  const storedBytes = [...workspace.files.values()].reduce((total, file) => total + file.size, 0);
  const pendingBytes = [...workspace.pendingUploads].reduce(
    (total, [pendingId, bytes]) => total + (pendingId === id ? 0 : bytes),
    0,
  );
  if (storedBytes + pendingBytes + size > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceError("WORKSPACE_SIZE_LIMIT", "세션 파일 총량은 200 MiB를 초과할 수 없습니다.", 413);
  }
  if (processBytes(id) + size > MAX_PROCESS_BYTES) {
    throw new WorkspaceError("SERVER_AT_CAPACITY", "서버 임시 저장 용량이 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 503);
  }
  workspace.pendingUploads.set(id, size);
}

export async function cancelUpload(principalKey: string, id: string): Promise<void> {
  assertLocalAdapterAllowed();
  workspaces.get(principalKey)?.pendingUploads.delete(id);
}

export async function cleanupFailedUpload(principalKey: string, id: string, filePath: string): Promise<void> {
  assertLocalAdapterAllowed();
  const workspace = workspaces.get(principalKey);
  if (!workspace) {
    await removePath(filePath, { force: true });
    return;
  }
  try {
    await removePath(filePath, { force: true });
    workspace.pendingUploads.delete(id);
    workspace.pendingCleanup.delete(id);
  } catch {
    // Retain byte accounting and retry during future activity/sweeps.
    workspace.pendingCleanup.set(id, filePath);
  }
}

async function retryPendingCleanup(workspace: Workspace): Promise<void> {
  for (const [id, filePath] of workspace.pendingCleanup) {
    try {
      await removePath(filePath, { force: true });
      workspace.pendingCleanup.delete(id);
      workspace.pendingUploads.delete(id);
    } catch {
      // Preserve accounting for a later retry.
    }
  }
}

/** Principal keys with a live workspace in this process. */
export async function activeWorkspaceKeys(): Promise<string[]> {
  assertLocalAdapterAllowed();
  return [...workspaces.keys()];
}

export function hasActiveWorkspace(principalKey: string): boolean {
  assertLocalAdapterAllowed();
  const workspace = workspaces.get(principalKey);
  return workspace !== undefined && workspace.tombstonedAt === undefined && workspace.committedExpiresAt > Date.now();
}

export function setWorkspaceRemoveForTest(remove: typeof rm): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_HOOK_UNAVAILABLE");
  const previous = removePath;
  removePath = remove;
  return () => {
    removePath = previous;
  };
}

/** Stored plus in-flight bytes across every workspace in this process. */
function processBytes(excludingUploadId?: string): number {
  let total = 0;
  for (const workspace of workspaces.values()) {
    for (const file of workspace.files.values()) total += file.size;
    for (const [id, bytes] of workspace.pendingUploads) {
      if (id !== excludingUploadId) total += bytes;
    }
  }
  return total;
}

/** Drops released and lease-expired tabs so the map cannot grow without bound. */
function pruneTabs(workspace: Workspace, now = Date.now()): void {
  for (const [tabId, tab] of workspace.tabs) {
    if (tab.released || tab.expiresAt <= now) workspace.tabs.delete(tabId);
  }
}

export async function registerFile(
  principalKey: string,
  input: {
    id: string;
    filePath: string;
    name: string;
    kind: FileKind;
    size: number;
    document: NormalizedDocument;
    normalizedSize: number;
  },
): Promise<FileSummary> {
  const workspace = await getWorkspace(principalKey);
  if (!workspace.pendingUploads.has(input.id)) {
    throw new WorkspaceError("UPLOAD_RESERVATION_INVALID", "업로드 예약이 유효하지 않습니다.", 409);
  }
  const storedBytes = [...workspace.files.values()].reduce((total, file) => total + file.size, 0);
  const normalizedSize = input.normalizedSize;
  if (!Number.isSafeInteger(normalizedSize) || normalizedSize <= 0) {
    throw new WorkspaceError("NORMALIZED_OUTPUT_INVALID", "정규화 결과 크기가 유효하지 않습니다.", 500);
  }
  const storedNormalizedBytes = [...workspace.files.values()].reduce((total, file) => total + file.normalizedSize, 0);
  const processNormalizedBytes = [...workspaces.values()].reduce(
    (total, candidate) =>
      total + [...candidate.files.values()].reduce((workspaceTotal, file) => workspaceTotal + file.normalizedSize, 0),
    0,
  );
  if (storedBytes + input.size > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceError("WORKSPACE_SIZE_LIMIT", "세션 파일 총량은 200 MiB를 초과할 수 없습니다.", 413);
  }
  if (normalizedSize > MAX_NORMALIZED_FILE_BYTES || storedNormalizedBytes + normalizedSize > MAX_NORMALIZED_WORKSPACE_BYTES) {
    throw new WorkspaceError("NORMALIZED_OUTPUT_LIMIT", "정규화된 문서 결과가 세션 메모리 한도를 초과했습니다.", 413);
  }
  if (processNormalizedBytes + normalizedSize > MAX_PROCESS_NORMALIZED_BYTES) {
    throw new WorkspaceError("SERVER_AT_CAPACITY", "서버 분석 메모리가 한도에 도달했습니다. 잠시 후 다시 시도하세요.", 503);
  }
  const expectedParent = `${workspaceDir(principalKey)}${path.sep}`;
  if (!path.resolve(input.filePath).startsWith(expectedParent)) {
    throw new WorkspaceError("STORAGE_BOUNDARY_VIOLATION", "임시 파일 경로가 세션 경계를 벗어났습니다.", 500);
  }
  const record: FileRecord = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    size: input.size,
    status: "ready",
    metadata: input.document.metadata,
    warnings: input.document.warnings,
    path: input.filePath,
    document: input.document,
    normalizedSize,
  };
  workspace.fence += 1;
  workspace.files.set(record.id, record);
  workspace.pendingUploads.delete(record.id);
  await touch(workspace);
  return summarize(record);
}

export async function listFiles(principalKey: string): Promise<FileSummary[]> {
  const workspace = await getWorkspace(principalKey);
  return [...workspace.files.values()].map(summarize);
}

export async function getFile(principalKey: string, fileId: string): Promise<FileRecord> {
  const workspace = await getWorkspace(principalKey);
  const file = workspace.files.get(fileId);
  if (!file) {
    throw new WorkspaceError("FILE_NOT_FOUND", "이 세션에서 파일을 찾을 수 없습니다.", 404);
  }
  return file;
}

export async function compareFiles(principalKey: string, baseId: string, targetId: string): Promise<ComparisonResult> {
  if (baseId === targetId) {
    throw new WorkspaceError("COMPARE_REQUIRES_TWO_FILES", "서로 다른 두 파일을 선택하세요.", 400);
  }
  const [{ document: base }, { document: target }] = await Promise.all([
    getFile(principalKey, baseId),
    getFile(principalKey, targetId),
  ]);
  const { buildComparison } = await import("@/domain/compare");
  try {
    return buildComparison(base, target);
  } catch (error) {
    if (error instanceof Error && error.message === "COMPARE_ALIGNMENT_LIMIT") {
      throw new WorkspaceError("COMPARE_ALIGNMENT_LIMIT", "문서 정렬 작업량이 한도를 초과했습니다.", 413);
    }
    throw error;
  }
}

export async function deleteWorkspace(principalKey: string): Promise<void> {
  assertLocalAdapterAllowed();
  const workspace = workspaces.get(principalKey);
  if (workspace?.deleteTimer) clearTimeout(workspace.deleteTimer);
  if (workspace) workspace.tombstonedAt = Date.now();
  await removePath(workspaceDir(principalKey), { recursive: true, force: true });
  workspaces.delete(principalKey);
}

export async function releaseWorkspace(principalKey: string, graceMs = 15_000): Promise<void> {
  assertLocalAdapterAllowed();
  const workspace = workspaces.get(principalKey);
  if (!workspace || workspace.deleteTimer) return;
  workspace.deleteTimer = setTimeout(() => {
    void deleteWorkspace(principalKey).catch(() => {
      if (workspace.deleteTimer) clearTimeout(workspace.deleteTimer);
      workspace.deleteTimer = undefined;
    });
  }, graceMs);
  workspace.deleteTimer.unref?.();
}

export function cancelWorkspaceRelease(principalKey: string): boolean {
  assertLocalAdapterAllowed();
  const workspace = workspaces.get(principalKey);
  if (!workspace?.deleteTimer) return false;
  clearTimeout(workspace.deleteTimer);
  workspace.deleteTimer = undefined;
  return true;
}

export async function registerTab(principalKey: string): Promise<{ tabId: string; releaseToken: string; leaseMs: number }> {
  const workspace = await getWorkspace(principalKey);
  pruneTabs(workspace);
  if (workspace.tabs.size >= MAX_LIVE_TABS_PER_WORKSPACE) {
    throw new WorkspaceError("TAB_LIMIT", "한 세션에서 열 수 있는 탭 수를 초과했습니다.", 429);
  }
  const tabId = randomUUID();
  const releaseToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const leaseMs = 90_000;
  workspace.tabs.set(tabId, { token: releaseToken, expiresAt: Date.now() + leaseMs, released: false });
  return { tabId, releaseToken, leaseMs };
}

export async function heartbeatTab(principalKey: string, tabId: string, token: string): Promise<void> {
  const workspace = await getWorkspace(principalKey, false, false);
  const tab = workspace.tabs.get(tabId);
  if (!tab || tab.token !== token || tab.released || tab.expiresAt <= Date.now()) {
    throw new WorkspaceError("LEASE_EXPIRED", "탭 세션이 만료되었습니다.", 409);
  }
  tab.expiresAt = Date.now() + 90_000;
  cancelWorkspaceRelease(principalKey);
  await touch(workspace);
}

export async function releaseTab(principalKey: string, tabId: string, token: string): Promise<void> {
  const workspace = await getWorkspace(principalKey, false, false);
  const tab = workspace.tabs.get(tabId);
  if (!tab || tab.token !== token) throw new WorkspaceError("RELEASE_TOKEN_INVALID", "탭 종료 토큰이 유효하지 않습니다.", 403);
  if (tab.released) return;
  tab.released = true;
  const now = Date.now();
  // A tab is live if it was not explicitly released and its lease is still
  // fresh (heartbeats keep the lease alive for both visible and hidden tabs).
  // An expired unreleased lease means the browser is gone without a clean exit.
  const live = [...workspace.tabs.values()].some(
    (candidate) => !candidate.released && candidate.expiresAt > now,
  );
  // Keep this tab's entry so a duplicate release stays an idempotent no-op; drop
  // the rest of the stale entries so the map cannot grow for the whole TTL.
  for (const [otherId, other] of workspace.tabs) {
    if (otherId !== tabId && (other.released || other.expiresAt <= now)) workspace.tabs.delete(otherId);
  }
  if (!live) await releaseWorkspace(principalKey);
}

export async function sweepExpired(now = Date.now()): Promise<number> {
  assertLocalAdapterAllowed();
  let removed = 0;
  for (const [principalKey, workspace] of workspaces) {
    await retryPendingCleanup(workspace);
    if (workspace.committedExpiresAt <= now) {
      try {
        await deleteWorkspace(principalKey);
        removed += 1;
      } catch {
        // Keep the workspace in memory so the next sweep can retry physical deletion.
      }
    }
  }
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || workspaces.has(entry.name)) continue;
    const dir = path.join(ROOT, entry.name);
    let expiresAt = 0;
    try {
      expiresAt = Number(await readFile(path.join(dir, EXPIRY_MARKER), "utf8"));
    } catch {
      try {
        const info = await stat(dir);
        expiresAt = info.mtimeMs + SESSION_TTL_MS;
      } catch {
        continue;
      }
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      try {
        await removePath(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // One orphan must not abort cleanup of every other workspace.
      }
    }
  }
  return removed;
}

function summarize(file: FileRecord): FileSummary {
  const { id, name, kind, size, status, metadata, warnings } = file;
  return { id, name, kind, size, status, metadata, warnings };
}

if (
  process.env.NODE_ENV !== "production" &&
  !globalState.__worklensCleanupStarted
) {
  globalState.__worklensCleanupStarted = true;
  void sweepExpired().catch(() => undefined);
  const timer = setInterval(() => void sweepExpired().catch(() => undefined), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
