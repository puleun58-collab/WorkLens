import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture } from "../fixtures/ax";
import { confirmedAxDiagnosis, axDiagnosisOutputSchema } from "../../src/lib/ax/schema";
import type { AxState } from "../../src/lib/ax/types";

async function stored(page: Page): Promise<AxState> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-ax", 1);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const value = await new Promise<AxState>((resolve, reject) => {
      const req = db.transaction("state").objectStore("state").get("current");
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close(); return value;
  });
}
async function enter(page: Page) { await navigateWorkspace(page, "업무 자동화 진단"); await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible(); }
async function step(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  // 탭 전환이 완전히 반영될 때까지 대기 (이전 패널이 사라지고 새 패널만 남음)
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
async function select(page: Page, name: string) {
  const btn = page.locator(".ax-task-row-btn:visible").filter({ has: page.locator(".ax-task-name", { hasText: new RegExp(`^${name}$`) }) });
  // 탭 전환 중 이전/새 패널이 동시에 보일 수 있어 정확히 1개일 때까지 대기
  await expect(btn).toHaveCount(1);
  await btn.click();
}

for (const width of [1440, 390]) test(`AX two-task ID-linked four-stage flow, independent calculations and transfer at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const requests: { kind: string; name?: string; description?: string; task?: { name: string } }[] = [];
  await page.route("**/api/ai", async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    if (input.kind === "ax-plan") {
      const marker = input.task.name;
      await route.fulfill({ json: { data: { kind: "ax-plan", plan: { ...planFixture, goal: [`${marker} 계획`], inScope: [`${marker} 자료 수집`] } } } });
      return;
    }
    const values = input.name === "업무 A" ? [4, 4, 4, 4, 2, 2] : [3, 3, 3, 3, 3, 2];
    const diagnosis = structuredClone(diagnosisFixture);
    diagnosis.factors.forEach((f, i) => { f.aiValue = values[i]; });
    diagnosis.asIs.purpose = `${input.name} 입력 자료 취합`;
    await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: axDiagnosisOutputSchema.parse(confirmedAxDiagnosis(diagnosis)) } } });
  });
  await page.goto("/"); await enter(page);
  for (const name of ["업무 A", "업무 B"]) {
    await page.getByLabel("업무명", { exact: true }).fill(name);
    await page.getByLabel("업무 설명", { exact: true }).fill(`${name}의 독립된 입력 표를 취합하고 담당자가 최종 승인합니다.`);
    await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  }
  await expect.poll(async () => (await stored(page))?.tasks.length).toBe(2);
  const registered = await stored(page);
  const aId = registered.tasks.find(t => t.name === "업무 A")!.id, bId = registered.tasks.find(t => t.name === "업무 B")!.id;
  expect(aId).not.toBe(bId); expect(registered.selectedTaskId).toBe(bId);
  await step(page, "업무 진단"); await select(page, "업무 A");
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  await expect(page.locator(".ax-factor-row")).toHaveCount(6);
  await page.getByRole("button", { name: "반복성 1점", exact: true }).click();
  await expect.poll(async () => (await stored(page)).tasks.find(t => t.id === aId)?.diagnosis?.factors[0].finalValue).toBe(1);
  await select(page, "업무 B"); await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.locator(".ax-factor-row")).toHaveCount(6);
  await expect.poll(async () => (await stored(page)).tasks.find(t => t.id === bId)?.diagnosis?.factors[0].aiValue).toBe(3);
  expect(requests.filter(r => r.kind === "ax-diagnosis").map(r => [r.name, r.description])).toEqual([
    ["업무 A", "업무 A의 독립된 입력 표를 취합하고 담당자가 최종 승인합니다."],
    ["업무 B", "업무 B의 독립된 입력 표를 취합하고 담당자가 최종 승인합니다."],
  ]);
  await step(page, "자동화 매트릭스");
  // Independent arithmetic: A value round(9/3)=3, feasibility=4, score=6+6-2-3=7.
  // B value=3, feasibility=3, score=6+4.5-3-3=4.5. Both Level 2; Gate remains conditional.
  const expected = [{ id: aId, name: "업무 A", x: "75%", y: "50%", score: "7" }, { id: bId, name: "업무 B", x: "50%", y: "50%", score: "4.5" }];
  for (const row of expected) {
    const marker = page.locator(".ax-bubble").and(page.getByRole("button", { name: new RegExp(`^${row.name} ·`) }));
    expect(await marker.evaluate(e => ({ x: (e as HTMLElement).style.left, y: (e as HTMLElement).style.bottom }))).toEqual({ x: row.x, y: row.y });
    await marker.click(); await expect.poll(async () => (await stored(page)).selectedTaskId).toBe(row.id);
    await expect(page.locator(".ax-matrix-detail")).toContainText(row.name);
  }
  await page.locator(".ax-bubble").and(page.getByRole("button", { name: /^업무 A ·/ })).click();
  await step(page, "결과·로드맵"); await expect(page.locator(".ax-report-intro h2")).toHaveText("업무 A");
  await expect(page.locator(".ax-plan-head")).toContainText("Level 2"); await expect(page.locator(".ax-plan-head")).toContainText("확인 후 진행");
  for (const row of expected) {
    const top = page.locator(".ax-step4-overview .ax-priority-list").first();
    const item = top.getByRole("listitem").filter({ has: page.locator(".ax-task-name", { hasText: row.name }) });
    await expect(item).toContainText(`점수 ${row.score}`); await item.getByRole("button").click();
    await expect(page.locator(".ax-report-intro h2")).toHaveText(row.name);
    await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
    await expect.poll(async () => (await stored(page)).tasks.find(t => t.id === row.id)?.diagnosis?.planCodex?.goal).toEqual([`${row.name} 계획`]);
    await page.getByRole("button", { name: "전체 보기", exact: true }).click();
    await expect(page.locator(".ax-prompt")).toContainText(row.name);
    await expect(page.locator(".ax-prompt")).toContainText("담당자 최종 승인");
  }
  await expect.poll(async () => (await stored(page)).selectedTaskId).toBe(bId);
  const beforeReload = await stored(page);
  await page.reload(); await enter(page);
  await expect(page.locator(".ax-report-intro h2")).toHaveText("업무 B");
  expect(await stored(page)).toEqual(beforeReload);
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  const download = page.waitForEvent("download"); await page.getByRole("menuitem", { name: "데이터 내보내기", exact: true }).click();
  const path = await (await download).path();
  const json = await readFile(path!, "utf8");
  expect(JSON.parse(json).data).toEqual(beforeReload);
  await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
  const chooser = page.waitForEvent("filechooser"); await page.getByRole("menuitem", { name: "데이터 가져오기", exact: true }).click();
  await (await chooser).setFiles({ name: "roundtrip.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await page.getByRole("alertdialog").getByRole("button", { name: "덮어쓰기", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual(beforeReload);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `artifacts/ax/integrity-four-stage-${width}.png`, fullPage: true });
});
