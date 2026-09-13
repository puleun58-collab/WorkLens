import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { NormalizedDocument } from "@/domain/document";

const TTL_MS = 400;
let root: string;
let store: typeof import("@/server/workspace-store");
let principalFromCredential: typeof import("@/server/session").principalFromCredential;
let createSessionIdentity: typeof import("@/server/session").createSessionIdentity;

const document = (fileId: string): NormalizedDocument => ({
  id: `document:${fileId}`,
  fileId,
  kind: "xlsx",
  metadata: { fileName: "운임현황.xlsx", sheets: [{ name: "운송단가", visibility: "visible", rowCount: 2, columnCount: 2 }] },
  blocks: [],
  warnings: [],
});

async function seedFile(principalKey: string, name = "운임현황.xlsx", size = 7) {
  await store.createWorkspace(principalKey);
  const allocation = await store.allocateUpload(principalKey, "xlsx");
  await writeFile(allocation.filePath, "fixture");
  return store.registerFile(principalKey, {
    id: allocation.id,
    filePath: allocation.filePath,
    name,
    kind: "xlsx",
    size,
    document: document(allocation.id),
    normalizedSize: 2,
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "worklens-test-"));
  process.env.WORKLENS_TEMP_DIR = root;
  process.env.WORKLENS_SESSION_TTL_MS = String(TTL_MS);
  store = await import("@/server/workspace-store");
  ({ principalFromCredential, createSessionIdentity } = await import("@/server/session"));
});

describe("ephemeral per-session workspace", () => {
  it("keeps each anonymous session's files private", async () => {
    const owner = createSessionIdentity().principalKey;
    const intruder = createSessionIdentity().principalKey;
    const file = await seedFile(owner);

    await expect(store.listFiles(owner)).resolves.toHaveLength(1);
    await store.createWorkspace(intruder);
    await expect(store.listFiles(intruder)).resolves.toEqual([]);
    await expect(store.getFile(intruder, file.id)).rejects.toMatchObject({ code: "FILE_NOT_FOUND", status: 404 });
  });

  it("rejects access for a session that never existed", async () => {
    const unknown = principalFromCredential(createSessionIdentity().credential);
    await expect(store.getFile(unknown, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 410,
    });
  });

  it("stores files under a per-principal directory and blocks path escapes", async () => {
    const owner = createSessionIdentity().principalKey;
    const file = await seedFile(owner);
    const entries = await readdir(path.join(root, owner));
    expect(entries).toContain(`${file.id}.xlsx`);

    const escapeAllocation = await store.allocateUpload(owner, "xlsx");
    await expect(
      store.registerFile(owner, {
        id: escapeAllocation.id,
        filePath: path.join(root, "..", "escape.xlsx"),
        name: "escape.xlsx",
        kind: "xlsx",
        size: 1,
        document: document("escape"),
        normalizedSize: 2,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_BOUNDARY_VIOLATION" });
  });

  it("refuses to compare a file with itself", async () => {
    const owner = createSessionIdentity().principalKey;
    const file = await seedFile(owner);
    await expect(store.compareFiles(owner, file.id, file.id)).rejects.toMatchObject({
      code: "COMPARE_REQUIRES_TWO_FILES",
    });
  });

  it("never silently revives an expired session", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    await new Promise((resolve) => setTimeout(resolve, TTL_MS + 120));
    await expect(store.listFiles(owner)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 410 });
    await expect(store.getWorkspace(owner)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 410 });
  });

  it("expires the workspace and deletes temporary files after the TTL", async () => {
    const owner = createSessionIdentity().principalKey;
    const file = await seedFile(owner);
    const dir = path.join(root, owner);
    await expect(stat(dir)).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, TTL_MS + 120));
    await store.sweepExpired();

    await expect(store.getFile(owner, file.id)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 410 });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes orphaned workspace directories left by a previous process", async () => {
    const orphan = createSessionIdentity().principalKey;
    const dir = path.join(root, orphan);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".expires-at"), String(Date.now() - 60_000));
    await writeFile(path.join(dir, "leftover.xlsx"), "stale");

    await store.sweepExpired();

    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("extends expiry on activity", async () => {
    const owner = createSessionIdentity().principalKey;
    const file = await seedFile(owner);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, TTL_MS / 2));
      await expect(store.getFile(owner, file.id)).resolves.toMatchObject({ id: file.id });
    }
  });

  it("uses a grace window for tab release and cancels deletion on activity", async () => {
    const owner = createSessionIdentity().principalKey;
    const file = await seedFile(owner);
    await store.releaseWorkspace(owner, 80);
    await expect(store.getFile(owner, file.id)).resolves.toMatchObject({ id: file.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(store.getFile(owner, file.id)).resolves.toMatchObject({ id: file.id });

    await store.releaseWorkspace(owner, 50);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(store.getFile(owner, file.id)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("cancels pending final-tab deletion when the session is reopened", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    await store.releaseWorkspace(owner, 30);
    await store.createWorkspace(owner);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(store.listFiles(owner)).resolves.toHaveLength(1);
  });

  it("requires a token-bound final tab release before deletion", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    const first = await store.registerTab(owner);
    const second = await store.registerTab(owner);
    await expect(store.releaseTab(owner, first.tabId, "x".repeat(64))).rejects.toMatchObject({ code: "RELEASE_TOKEN_INVALID" });
    await store.releaseTab(owner, first.tabId, first.releaseToken);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(store.listFiles(owner)).resolves.toHaveLength(1);
    await store.releaseTab(owner, second.tabId, second.releaseToken);
  });

  it("does not cancel pending deletion for an invalid release token", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    const tab = await store.registerTab(owner);
    await store.releaseWorkspace(owner, 30);
    await expect(store.releaseTab(owner, tab.tabId, "x".repeat(64))).rejects.toMatchObject({
      code: "RELEASE_TOKEN_INVALID",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(store.listFiles(owner)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("keeps the pending deletion timer on duplicate final release", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    const tab = await store.registerTab(owner);
    await store.releaseTab(owner, tab.tabId, tab.releaseToken);
    await store.releaseTab(owner, tab.tabId, tab.releaseToken);
    await new Promise((resolve) => setTimeout(resolve, 15_050));
    await expect(store.listFiles(owner)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  }, 20_000);

  it("enforces per-workspace file-count and byte ceilings", async () => {
    const countOwner = createSessionIdentity().principalKey;
    for (let index = 0; index < 10; index += 1) await seedFile(countOwner, `${index}.xlsx`);
    await expect(store.allocateUpload(countOwner, "xlsx")).rejects.toMatchObject({ code: "WORKSPACE_FILE_LIMIT" });

    const sizeOwner = createSessionIdentity().principalKey;
    await seedFile(sizeOwner, "large.xlsx", 200 * 1024 * 1024);
    const allocation = await store.allocateUpload(sizeOwner, "xlsx");
    await writeFile(allocation.filePath, "fixture");
    await expect(store.registerFile(sizeOwner, {
      id: allocation.id,
      filePath: allocation.filePath,
      name: "overflow.xlsx",
      kind: "xlsx",
      size: 1,
      document: document(allocation.id),
      normalizedSize: 2,
    })).rejects.toMatchObject({ code: "WORKSPACE_SIZE_LIMIT" });
  });

  it("bounds live tabs per workspace and prunes released leases", async () => {
    const owner = createSessionIdentity().principalKey;
    await seedFile(owner);
    const tabs = [];
    for (let index = 0; index < 20; index += 1) tabs.push(await store.registerTab(owner));
    await expect(store.registerTab(owner)).rejects.toMatchObject({ code: "TAB_LIMIT", status: 429 });

    // Releasing frees capacity because released leases are pruned.
    await store.releaseTab(owner, tabs[0].tabId, tabs[0].releaseToken);
    await expect(store.registerTab(owner)).resolves.toBeDefined();
  });

  it("refuses new workspaces once the process-wide session ceiling is reached", async () => {
    // Earlier cases in this file share the process-wide map, so drain it first and
    // restore nothing afterwards beyond what this case created.
    const preexisting = await store.activeWorkspaceKeys();
    for (const key of preexisting) await store.deleteWorkspace(key);

    const owners: string[] = [];
    try {
      for (let index = 0; index < 50; index += 1) {
        const owner = createSessionIdentity().principalKey;
        owners.push(owner);
        await store.createWorkspace(owner);
      }
      await expect(store.createWorkspace(createSessionIdentity().principalKey)).rejects.toMatchObject({
        code: "SERVER_AT_CAPACITY",
        status: 503,
      });
    } finally {
      for (const owner of owners) await store.deleteWorkspace(owner);
    }
  });

  it("reserves in-flight upload slots atomically", async () => {
    const owner = createSessionIdentity().principalKey;
    await store.createWorkspace(owner);
    const reservations = await Promise.all(Array.from({ length: 10 }, () => store.allocateUpload(owner, "xlsx")));
    await expect(store.allocateUpload(owner, "xlsx")).rejects.toMatchObject({ code: "WORKSPACE_FILE_LIMIT" });
    await Promise.all(reservations.map(({ id }) => store.cancelUpload(owner, id)));
    await expect(store.allocateUpload(owner, "xlsx")).resolves.toBeDefined();
  });

  it("enforces the process-wide pending byte ceiling across principals", async () => {
    const preexisting = await store.activeWorkspaceKeys();
    for (const key of preexisting) await store.deleteWorkspace(key);
    const reservations: Array<{ owner: string; id: string }> = [];
    let overflowOwner: string | undefined;
    try {
      for (let index = 0; index < 4; index += 1) {
        const owner = createSessionIdentity().principalKey;
        await store.createWorkspace(owner);
        const allocation = await store.allocateUpload(owner, "xlsx");
        await store.reserveUploadBytes(owner, allocation.id, 50 * 1024 * 1024);
        reservations.push({ owner, id: allocation.id });
      }
      overflowOwner = createSessionIdentity().principalKey;
      await store.createWorkspace(overflowOwner);
      const overflow = await store.allocateUpload(overflowOwner, "xlsx");
      await expect(store.reserveUploadBytes(overflowOwner, overflow.id, 1)).rejects.toMatchObject({
        code: "SERVER_AT_CAPACITY",
        status: 503,
      });
    } finally {
      for (const { owner } of reservations) await store.deleteWorkspace(owner);
      if (overflowOwner) await store.deleteWorkspace(overflowOwner);
    }
  });

  it("enforces the process-wide normalized memory ceiling across principals", async () => {
    const preexisting = await store.activeWorkspaceKeys();
    for (const key of preexisting) await store.deleteWorkspace(key);
    const owners: string[] = [];
    try {
      for (let workspaceIndex = 0; workspaceIndex < 2; workspaceIndex += 1) {
        const owner = createSessionIdentity().principalKey;
        owners.push(owner);
        await store.createWorkspace(owner);
        for (let fileIndex = 0; fileIndex < 5; fileIndex += 1) {
          const allocation = await store.allocateUpload(owner, "xlsx");
          await writeFile(allocation.filePath, "x");
          await store.reserveUploadBytes(owner, allocation.id, 1);
          await store.registerFile(owner, {
            id: allocation.id,
            filePath: allocation.filePath,
            name: `${fileIndex}.xlsx`,
            kind: "xlsx",
            size: 1,
            document: document(allocation.id),
            normalizedSize: 20 * 1024 * 1024,
          });
        }
      }
      const overflowOwner = createSessionIdentity().principalKey;
      owners.push(overflowOwner);
      await store.createWorkspace(overflowOwner);
      const overflow = await store.allocateUpload(overflowOwner, "xlsx");
      await writeFile(overflow.filePath, "x");
      await store.reserveUploadBytes(overflowOwner, overflow.id, 1);
      await expect(store.registerFile(overflowOwner, {
        id: overflow.id,
        filePath: overflow.filePath,
        name: "overflow.xlsx",
        kind: "xlsx",
        size: 1,
        document: document(overflow.id),
        normalizedSize: 1,
      })).rejects.toMatchObject({ code: "SERVER_AT_CAPACITY", status: 503 });
    } finally {
      for (const owner of owners) await store.deleteWorkspace(owner);
    }
  });

  it("keeps failed-upload bytes accounted until physical cleanup succeeds", async () => {
    const owner = createSessionIdentity().principalKey;
    await store.createWorkspace(owner);
    const allocation = await store.allocateUpload(owner, "xlsx");
    await writeFile(allocation.filePath, "sensitive");
    await store.reserveUploadBytes(owner, allocation.id, 9);
    let attempts = 0;
    const restore = store.setWorkspaceRemoveForTest(async (target, options) => {
      if (String(target) === allocation.filePath && attempts++ === 0) throw new Error("locked");
      return rm(target, options);
    });
    try {
      await store.cleanupFailedUpload(owner, allocation.id, allocation.filePath);
      await expect(store.allocateUpload(owner, "xlsx")).resolves.toBeDefined();
      await store.getWorkspace(owner);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
      await store.deleteWorkspace(owner);
    }
  });
});
