import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { emptyAxState, type AxStateV2 } from "../../src/lib/ax/types";
import { exportAxState } from "../../src/lib/ax/transfer";
import { taskFixture } from "../fixtures/ax";
async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open("worklens-ax", 1); req.onupgradeneeded = () => req.result.createObjectStore("state"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(record, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, value);
}
async function raw(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const record = await new Promise(resolve => { const req = db.transaction("state").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); }); db.close(); return record;
  });
}
async function enter(page: Page) { await navigateWorkspace(page, "업무 자동화 진단"); await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible(); }
async function register(page: Page, name: string) { await page.getByLabel("업무명", { exact: true }).fill(name); await page.getByLabel("업무 설명", { exact: true }).fill(`${name} 자료 취합과 담당자 승인`); await page.getByRole("button", { name: "업무 등록", exact: true }).click(); }
async function importData(page: Page, value: AxStateV2) {
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  const chooser = page.waitForEvent("filechooser"); await page.getByRole("menuitem", { name: "데이터 가져오기", exact: true }).click();
  await (await chooser).setFiles({ name: "restore.json", mimeType: "application/json", buffer: Buffer.from(exportAxState(value)) });
}
for (const original of [{ schemaVersion: 1, tasks: [{ id: "broken" }], selectedTaskId: null, step: 1 }, { schemaVersion: 99, tasks: [{ id: "future", original: "미지원 원본" }] }]) {
  test(`AX protects invalid record version ${original.schemaVersion} through local changes, reload, import cancel and explicit recovery`, async ({ page }) => {
    await page.goto("/"); await seed(page, original); await enter(page);
    await expect(page.getByRole("status").filter({ hasText: "원본을 보존" })).toBeVisible();
    await register(page, "보관용 화면 작업"); await navigateWorkspace(page, "분석"); expect(await raw(page)).toEqual(original);
    await page.reload(); await enter(page); expect(await raw(page)).toEqual(original);
    const task = taskFixture("recovered"); const recovered = { ...emptyAxState(), tasks: [task], selectedTaskId: task.id };
    await importData(page, recovered); await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click(); expect(await raw(page)).toEqual(original);
    await importData(page, recovered); await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
    await expect.poll(() => raw(page)).toEqual(recovered);
    await register(page, "복구 후 추가"); await expect.poll(async () => ((await raw(page)) as AxStateV2).tasks.map(t => t.name)).toEqual([task.name, "복구 후 추가"]);
  });
}
for (const notifications of [true, false]) test(`AX prevents stale cross-tab writes with BroadcastChannel ${notifications ? "enabled" : "unavailable"}`, async ({ page, context }) => {
  if (!notifications) await context.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { value: undefined }); });
  await page.goto("/"); await enter(page); await register(page, "초기 업무");
  await expect.poll(async () => ((await raw(page)) as AxStateV2 | undefined)?.tasks.length).toBe(1);
  const other = await context.newPage(); await other.goto("/"); await enter(other);
  await register(page, "A 탭 추가"); await expect.poll(async () => ((await raw(page)) as AxStateV2).tasks.length).toBe(2);
  const winner = await raw(page);
  if (notifications) await expect(other.getByRole("status").filter({ hasText: "다른 탭" })).toBeVisible();
  await register(other, "B 탭 독립 변경");
  if (!notifications) await expect(other.getByRole("status").filter({ hasText: "다른 탭" }).first()).toBeVisible();
  await navigateWorkspace(other, "분석"); expect(await raw(page)).toEqual(winner);
  await other.reload(); await enter(other);
  await expect(other.getByLabel("등록 업무 목록")).toContainText("A 탭 추가");
  await expect(other.getByLabel("등록 업무 목록")).not.toContainText("B 탭 독립 변경");
  expect(await raw(other)).toEqual(winner); await other.close();
});

test("AX failed write preserves the prior record and exposes local work for export without claiming save success", async ({ page }) => {
  await page.goto("/"); await enter(page); await register(page, "저장된 원본");
  await expect.poll(async () => ((await raw(page)) as AxStateV2 | undefined)?.tasks.length).toBe(1);
  const original = await raw(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "state") throw new DOMException("Test quota exhausted", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await register(page, "저장 실패 화면 작업");
  await expect(page.getByRole("status").filter({ hasText: "자동 저장에 실패" })).toBeVisible();
  expect(await raw(page)).toEqual(original);
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "데이터 내보내기", exact: true }).click();
  const exportedPath = await (await download).path();
  const exported = JSON.parse(await readFile(exportedPath!, "utf8"));
  expect(exported.data.tasks.map((task: { name: string }) => task.name)).toEqual(["저장된 원본", "저장 실패 화면 작업"]);
  await navigateWorkspace(page, "분석");
  expect(await raw(page)).toEqual(original);
  await page.reload(); await enter(page);
  await expect(page.getByLabel("등록 업무 목록")).toContainText("저장된 원본");
  await expect(page.getByLabel("등록 업무 목록")).not.toContainText("저장 실패 화면 작업");
});
