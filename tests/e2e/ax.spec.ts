import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxState } from "../../src/lib/ax/types";
import { exportAxState } from "../../src/lib/ax/transfer";
async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
}
async function register(page: Page, name = "월간 취합") {
  await page.getByLabel("업무명(선택)", { exact: true }).fill(name);
  await page.getByLabel("업무 설명(필수)", { exact: true }).fill("매월 입력 표를 취합하고 담당자가 최종 승인합니다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
}
async function seed(page: Page, value: unknown) {
  await page.evaluate(async record => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(record, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, value);
}
async function record(page: Page): Promise<AxState | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<AxState | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close(); return value;
  });
}
async function dataAction(page: Page, name: string) {
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function importData(page: Page, content: string) {
  await page.getByLabel("AX 데이터 가져오기 파일").setInputFiles({ name: "ax.json", mimeType: "application/json", buffer: Buffer.from(content) });
}
function mock(page: Page, calls: Record<string, unknown>[] = []) {
  return page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON(); calls.push(req);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
}
test("AX registration → diagnosis → correction → matrix → plans → reload → export/reset/import", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "선택 업무 진단으로" }).click();
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  await page.getByLabel("반복성 보정", { exact: true }).fill("1");
  await expect(page.getByText("사용자 보정 완료", { exact: true }).last()).toBeVisible();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: false }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toContainText("검토 후보");
  await page.screenshot({ path: `artifacts/ax/matrix-${test.info().project.name}.png` });
  await page.getByRole("tab", { name: "결과·로드맵", exact: false }).click();
  await expect(page.getByRole("table", { name: "업무 우선순위" })).toContainText("L2 부분 자동화");
  await expect(page.getByRole("table", { name: "업무 우선순위" })).toContainText("자동화 가치 3");
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex용 구현 계획", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claude Code용 구현 계획", exact: true })).toBeVisible();
  expect(calls.map(c => c.kind)).toEqual(["ax-diagnosis", "ax-plan", "ax-plan"]);
  expect(calls[1]).toMatchObject({ target: "codex", diagnosis: { factors: expect.arrayContaining([expect.objectContaining({ key: "repetition", finalValue: 1 })]) } });
  expect(calls[2]).toHaveProperty("target", "claude");
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
  const saved = await record(page); expect(saved?.step).toBe(4);
  await page.reload(); await ax(page);
  await expect(page.getByRole("tab", { name: "결과·로드맵" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Codex용 구현 계획", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Claude Code용 구현 계획", exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download"); await dataAction(page, "내보내기");
  const path = await (await downloaded).path(); const content = await readFile(path!, "utf8");
  expect(JSON.parse(content).data).toEqual(saved);
  await page.evaluate(() => localStorage.setItem("ax-unrelated-fixture", "keep"));
  await dataAction(page, "초기화"); await page.getByRole("alertdialog").getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.getByText("등록된 업무가 없습니다.", { exact: false })).toBeVisible();
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨"); expect(await record(page)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("ax-unrelated-fixture"))).toBe("keep");
  await importData(page, content);
  await expect(page.getByRole("heading", { name: "Codex용 구현 계획", exact: true })).toBeVisible();
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨"); expect(await record(page)).toEqual(saved);
  await page.reload(); await ax(page); await expect(page.getByRole("heading", { name: "Claude Code용 구현 계획", exact: true })).toBeVisible();
});
test("AX batch candidates edit, split, merge, delete before registration and mobile guide", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/"); await ax(page);
  const steps = page.getByRole("tablist", { name: "진단 단계" });
  await expect(steps.getByRole("tab")).toHaveCount(4);
  // Check every label's actual text bounds: document overflow alone misses clipped tablists.
  expect(await steps.evaluate(list => {
    const bounds = list.getBoundingClientRect();
    return list.scrollWidth <= list.clientWidth && bounds.left >= 0 && bounds.right <= window.innerWidth &&
      Array.from(list.querySelectorAll("[role=tab]")).every(tab => {
        const box = tab.getBoundingClientRect();
        const label = tab.querySelector(".ax-step-label")!;
        const range = document.createRange(); range.selectNodeContents(label);
        return box.left >= bounds.left && box.right <= bounds.right &&
          Array.from(range.getClientRects()).every(text => text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom);
      });
  })).toBe(true);
  await page.screenshot({ path: `artifacts/ax/registration-mobile-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "여러 업무 한 번에 추가" }).click();
  await page.getByLabel("업무 목록 입력").fill("1. 자료 취합\n2. 보고서 작성\n- 삭제할 업무");
  await page.getByRole("button", { name: "후보 만들기" }).click();
  await page.getByLabel("후보 1", { exact: true }).fill("자료 취합\n승인 요청");
  await page.locator(".ax-candidate").first().getByRole("button", { name: "분리", exact: true }).click();
  await expect(page.locator(".ax-candidate")).toHaveCount(4);
  await page.locator(".ax-candidate").first().getByRole("button", { name: "다음과 합치기" }).click();
  await expect(page.locator(".ax-candidate")).toHaveCount(3);
  await page.locator(".ax-candidate").last().getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "후보 확정 · 업무 등록" }).click();
  await expect(page.getByLabel("등록 업무 목록").locator("li")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await navigateWorkspace(page, "Guide"); await page.getByRole("tab", { name: "업무 자동화 진단", exact: true }).click();
  await expect(page.getByRole("tabpanel").locator(".usage-guide-step")).toHaveCount(4);
  await expect(page.getByRole("tabpanel")).toContainText("재분석 시 다시 첨부");
});
test("AX validates imports before replacement, cancel preserves existing data and reset cancel works", async ({ page }) => {
  await page.goto("/"); await ax(page); await register(page, "기존 업무");
  const imported = exportAxState({ ...emptyAxState(), tasks: [taskFixture("imported")] , selectedTaskId: "imported" });
  await importData(page, "{broken"); await expect(page.getByText("올바른 JSON 파일이 아닙니다.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await importData(page, imported); await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("기존 업무");
  await importData(page, imported); await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("업무 imported");
  await dataAction(page, "초기화"); await page.getByRole("alertdialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("등록 업무 목록")).toContainText("업무 imported");
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
});
test("AX safely resets unsupported/corrupt IndexedDB records", async ({ page }) => {
  await page.goto("/"); await seed(page, { schemaVersion: 99, tasks: "broken" }); await ax(page);
  await expect(page.getByText("안전하게 초기화했습니다", { exact: false })).toBeVisible();
  await expect(page.getByText("등록된 업무가 없습니다.", { exact: false })).toBeVisible();
  await expect.poll(async () => (await record(page))?.schemaVersion).toBe(1);
  expect((await record(page))?.tasks).toEqual([]);
});
test("AX styled file selection shows filenames and removes draft/session attachments", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page);
  const file = { name: "selected.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n취합,매월") };
  const input = page.getByLabel("진단 참고 파일(선택)");
  await expect(input).toBeHidden();
  const selectFile = async () => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "파일 선택", exact: true }).click();
    await (await chooser).setFiles(file);
    await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
    await expect(page.getByText("selected.csv · 세션 요약 준비됨", { exact: false })).toBeVisible();
  };
  await selectFile();
  await page.getByRole("button", { name: "첨부 취소", exact: true }).click();
  await expect(page.getByText("selected.csv", { exact: false })).toHaveCount(0);
  await selectFile(); // The same file can be selected again after removal.
  await register(page);
  await page.getByRole("button", { name: "선택 업무 진단으로" }).click();
  await expect(page.getByLabel("첨부 파일 다시 선택")).toBeHidden();
  await expect(page.locator(".ax-attachment")).toContainText("selected.csv · 세션 요약 준비됨");
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await expect(page.locator(".ax-attachment")).not.toContainText("selected.csv");
  await expect(input).toBeHidden();
  await selectFile();
  await page.getByRole("button", { name: "첨부 해제", exact: true }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]).not.toHaveProperty("attachmentSummary");
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
  expect((await record(page))?.tasks[0].attachmentMeta).toBeUndefined();
});
test("AX attachment summaries stay out of storage/export and reload requires reattachment", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "선택 업무 진단으로" }).click();
  await page.getByLabel("진단 참고 파일(선택)").setInputFiles({ name: "monthly.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기,처리\n표취합,매월,승인\n보고,매월,담당자 검토") });
  await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("첨부 파일 요약 기반 진단", { exact: false })).toBeVisible();
  expect(calls[0]).toHaveProperty("attachmentSummary"); expect(calls[0]).not.toHaveProperty("bytes");
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
  const stored = await record(page); expect(stored?.tasks[0].attachmentMeta?.fingerprint).toHaveLength(64);
  expect(JSON.stringify(stored)).not.toContain("attachmentSummary"); expect(JSON.stringify(stored)).not.toContain("bytes");
  const download = page.waitForEvent("download"); await dataAction(page, "내보내기");
  const exported = await readFile((await (await download).path())!, "utf8");
  expect(exported).not.toContain("attachmentSummary"); expect(exported).not.toContain("bytes");
  expect(JSON.parse(exported).data.tasks[0].attachmentMeta).toEqual(stored?.tasks[0].attachmentMeta);
  await page.reload(); await ax(page);
  await expect(page.locator(".ax-attachment")).toContainText("첨부 파일이 사용됨 — 재분석 시 재첨부 필요");
  await page.getByRole("button", { name: "업무 다시 진단" }).click(); expect(calls).toHaveLength(1);
  await page.getByLabel("첨부 파일 다시 선택").setInputFiles({ name: "monthly.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n표취합,매월") });
  await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "업무 진단 실행" }).click(); await expect(page.getByText("정보 충분", { exact: true })).toBeVisible(); expect(calls).toHaveLength(2);
});
test("AX follows up on missing information and recalculates provisional decisions", async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/ai", async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: calls.length === 1 ? { ...outputFixture(), informationSufficiency: "needs-check", followUpQuestions: ["최종 승인자는 누구인가요?"] } : outputFixture() } }) }); });
  await page.goto("/"); await ax(page); await register(page); await page.getByRole("button", { name: "선택 업무 진단으로" }).click(); await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("핵심 확인사항 먼저 확인", { exact: true })).toBeVisible();
  await expect(page.locator(".ax-summary")).toContainText("잠정");
  await page.getByLabel("최종 승인자는 누구인가요?", { exact: true }).fill("업무 담당 팀장");
  await page.getByRole("button", { name: "답변 반영 재진단" }).click(); await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  expect(calls[1].description).toContain("업무 담당 팀장");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "자동화 매트릭스" }).click();
  await expect(page.getByLabel("매트릭스 업무 목록")).toBeVisible(); await expect(page.locator(".ax-matrix-desktop")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
test("AX works and exports when IndexedDB is unavailable and rejects failed AI output", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new Error("storage disabled"); } }); });
  await page.route("**/api/ai", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: { informationSufficiency: "sufficient" } } }) }));
  await page.goto("/"); await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.locator(".ax-save")).toHaveText("저장 실패"); await register(page);
  await expect(page.getByLabel("등록 업무 목록")).toContainText("월간 취합");
  await page.getByRole("button", { name: "선택 업무 진단으로" }).click(); await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("진단 실패", { exact: false })).toBeVisible(); await expect(page.getByText("진단 결과", { exact: true })).toHaveCount(0);
  const download = page.waitForEvent("download"); await dataAction(page, "내보내기"); const exported = JSON.parse(await readFile((await (await download).path())!, "utf8")); expect(exported.data.tasks).toHaveLength(1);
});
test("AX flushes pending changes on navigation and preserves the existing workspace", async ({ page }) => {
  await page.goto("/"); await ax(page); await register(page, "화면 이동 전에 등록");
  await navigateWorkspace(page, "Guide");
  await ax(page); await expect(page.getByLabel("등록 업무 목록")).toContainText("화면 이동 전에 등록");
  await expect(page.locator(".ax-save")).toHaveText("이 브라우저에 저장됨");
  await navigateWorkspace(page, "분석"); await expect(page.getByRole("heading", { name: "문서 분석", exact: true })).toBeVisible();
  await page.reload(); await ax(page); await expect(page.getByLabel("등록 업무 목록")).toContainText("화면 이동 전에 등록");
});
test("AX attachment cleanup leaves another view's AI request running", async ({ page }) => {
  const failed: string[] = [];
  const outcome = new Promise<string>(resolve => {
    page.on("requestfailed", request => { if (new URL(request.url()).pathname === "/api/ai") { failed.push(request.failure()?.errorText ?? "failed"); resolve("failed"); } });
    page.on("requestfinished", request => { if (new URL(request.url()).pathname === "/api/ai") resolve("finished"); });
  });
  let release: (() => void) | undefined;
  await page.route("**/api/ai", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "claims", claims: [] } }) }).catch(() => undefined);
  });
  await page.goto("/");
  await page.getByLabel("작업 파일 선택", { exact: true }).setInputFiles({ name: "existing.csv", mimeType: "text/csv", buffer: Buffer.from("항목,값\n월 자료,2\n취합,3") });
  await page.getByRole("checkbox", { name: "existing.csv 선택", exact: true }).check();
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await expect.poll(() => typeof release).toBe("function");
  await ax(page); await register(page);
  await page.getByRole("button", { name: "선택 업무 진단으로" }).click();
  // Keep the main-thread AX fingerprint operation pending during navigation;
  // the original document worker has its own crypto implementation.
  await page.evaluate(() => { Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: () => new Promise(() => {}) }); });
  await page.getByLabel("진단 참고 파일(선택)").setInputFiles({ name: "ax.csv", mimeType: "text/csv", buffer: Buffer.from("업무,주기\n취합,월") });
  await expect(page.getByRole("button", { name: "업무 진단 실행", exact: true })).toBeDisabled();
  await navigateWorkspace(page, "Guide");
  release?.();
  expect(await outcome).toBe("finished");
  expect(failed).toHaveLength(0);
});
