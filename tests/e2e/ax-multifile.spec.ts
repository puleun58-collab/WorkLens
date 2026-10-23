import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture } from "../fixtures/ax";
import type { AxState } from "../../src/lib/ax/types";

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function register(page: Page, name = "월간 취합") {
  await page.getByLabel("업무명", { exact: true }).fill(name);
  await page.getByLabel("업무 설명", { exact: true }).fill("매월 입력 표를 취합하고 담당자가 최종 승인합니다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
}
async function record(page: Page): Promise<AxState | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<AxState | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close(); return value;
  });
}
function mock(page: Page, calls: Record<string, unknown>[] = []) {
  return page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON(); calls.push(req);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
}
const csv = (name: string, body: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(body) });
const region = (page: Page) => page.getByRole("region", { name: "업무 자동화 진단", exact: true });
const fileInput = (page: Page) => region(page).getByLabel("파일 추가", { exact: true });

test("AX multi-file: select several at once, pastel rows, add more, duplicate and same-name handling, per-file removal", async ({ page }) => {
  await page.goto("/"); await ax(page);
  const input = fileInput(page);
  await input.setInputFiles([
    csv("경유가격_원본.csv", "품목,가격\n경유,1500\n휘발유,1600"),
    csv("주간실적.csv", "주차,실적\n1주차,10\n2주차,12"),
    csv("업무매뉴얼.csv", "절차,담당\n수집,담당자\n검토,팀장"),
  ]);
  await expect(page.getByText("첨부 요약을 준비했습니다.", { exact: false })).toBeVisible();
  const rows = page.locator(".ax-register-files .ax-file-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("경유가격_원본.csv");
  // 정상 상태에서는 '준비됨' 문구와 상태 요소 자체가 표시되지 않는다
  await expect(rows.nth(0)).not.toContainText("준비됨");
  await expect(rows.nth(0).locator(".ax-file-status")).toHaveCount(0);
  // 파스텔 블루 색상 실측 (ComputedStyle)
  const rowStyle = await rows.nth(0).evaluate(el => {
    const cs = getComputedStyle(el);
    const name = getComputedStyle(el.querySelector(".ax-file-name")!);
    const icon = getComputedStyle(el.querySelector("svg")!);
    return { background: cs.backgroundColor, border: cs.borderColor, name: name.color, icon: icon.color };
  });
  expect(rowStyle).toEqual({ background: "rgb(227, 236, 250)", border: "rgb(199, 216, 240)", name: "rgb(36, 52, 74)", icon: "rgb(82, 101, 127)" });
  // 기존 파일을 유지하면서 추가 첨부
  await input.setInputFiles([csv("보고서양식.csv", "항목,값\n합계,100")]);
  await expect(rows).toHaveCount(4);
  // 동일 파일(같은 이름·같은 내용) 중복 방지
  await input.setInputFiles([csv("경유가격_원본.csv", "품목,가격\n경유,1500\n휘발유,1600")]);
  await expect(page.getByText("중복으로 추가하지 않았습니다.", { exact: false })).toBeVisible();
  await expect(rows).toHaveCount(4);
  // 같은 이름·다른 내용은 별도 파일로 추가
  await input.setInputFiles([csv("경유가격_원본.csv", "품목,가격\n경유,1550")]);
  await expect(rows).toHaveCount(5);
  // 가운데 파일만 개별 제거, 나머지는 유지
  await rows.filter({ hasText: "주간실적.csv" }).getByRole("button", { name: "첨부 취소", exact: true }).click();
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "주간실적" })).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("경유가격_원본.csv");
  // 긴 파일명도 레이아웃을 밀어내지 않음
  await input.setInputFiles([csv("아주긴파일명을가진업무참고자료_2026년_상반기_최종버전_검토완료.csv", "a,b\n1,2")]);
  await expect(rows).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("AX multi-file: 10 file limit keeps the first 10 and explains the rest", async ({ page }) => {
  await page.goto("/"); await ax(page);
  const files = Array.from({ length: 11 }, (_, i) => csv(`자료${i + 1}.csv`, `항목,값\n자료${i + 1},${i}`));
  await fileInput(page).setInputFiles(files);
  await expect(page.locator(".ax-register-files .ax-file-row")).toHaveCount(10);
  await expect(page.getByText("최대 10개까지 가능합니다.", { exact: false })).toBeVisible();
  await expect(page.getByText("자료11.csv", { exact: false })).toHaveCount(1); // 안내 문구에만 등장, 행으로는 추가되지 않음
  await expect(page.locator(".ax-register-files .ax-file-row").filter({ hasText: "자료11" })).toHaveCount(0);
});

test("AX multi-file: partial failure keeps successful files and reports the failed one", async ({ page }) => {
  await page.goto("/"); await ax(page);
  await fileInput(page).setInputFiles([
    csv("정상.csv", "항목,값\n정상,1"),
    { name: "손상.pdf", mimeType: "application/pdf", buffer: Buffer.from("이것은 PDF가 아닙니다") },
    csv("빈파일.csv", ""),
  ]);
  await expect(page.locator(".ax-register-files .ax-file-row")).toHaveCount(1);
  await expect(page.locator(".ax-register-files .ax-file-row").nth(0)).toContainText("정상.csv");
  await expect(page.getByText("손상.pdf", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("빈 파일은 첨부할 수 없습니다.", { exact: false })).toBeVisible();
});

test("AX multi-file: diagnosis request carries the combined per-file summary and reload tracks each file", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page);
  await fileInput(page).setInputFiles([
    csv("입력자료.csv", "품목,수량\n연료,10\n윤활유,3"),
    csv("보고서양식.csv", "구분,양식\n월간,보고서"),
  ]);
  await expect(page.locator(".ax-register-files .ax-file-row")).toHaveCount(2);
  await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  const attachment = page.locator(".ax-attachment");
  await expect(attachment.locator(".ax-file-row")).toHaveCount(2);
  await expect(attachment).toContainText("입력자료.csv");
  await expect(attachment).toContainText("보고서양식.csv");
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("첨부 파일 요약 기반 진단", { exact: false })).toBeVisible();
  expect(calls).toHaveLength(1);
  const summary = calls[0].attachmentSummary as string;
  expect(summary).toContain("[첨부 파일 1: 입력자료.csv]");
  expect(summary).toContain("[첨부 파일 2: 보고서양식.csv]");
  expect(summary.length).toBeLessThanOrEqual(2000);
  expect(calls[0]).not.toHaveProperty("bytes");
  // 저장은 비동기 큐를 타므로 기록이 실제로 반영될 때까지 기다린다 (Firefox 등 느린 환경 대응)
  await expect.poll(async () => (await record(page))?.tasks[0].attachmentMetas).toHaveLength(2);
  const stored = await record(page);
  expect(stored?.tasks[0].attachmentMeta?.name).toBe("입력자료.csv");
  expect(JSON.stringify(stored)).not.toContain("attachmentSummary");
  // 진단 화면에서 파일 1개만 해제하면 나머지는 유지되고 진단은 무효화된다
  await attachment.locator(".ax-file-row").filter({ hasText: "보고서양식.csv" }).getByRole("button", { name: "첨부 해제", exact: true }).click();
  await expect(attachment.locator(".ax-file-row")).toHaveCount(1);
  await expect(attachment).toContainText("입력자료.csv");
  await expect.poll(async () => (await record(page))?.tasks[0]).toMatchObject({ status: "registered" });
  const afterDetach = await record(page);
  expect(afterDetach?.tasks[0].attachmentMetas).toBeUndefined();
  expect(afterDetach?.tasks[0].attachmentMeta?.name).toBe("입력자료.csv");
  expect(afterDetach?.tasks[0].diagnosis).toBeUndefined();
  // 새로고침 후에는 남은 파일도 재첨부가 필요하고, 같은 파일을 다시 선택하면 요약이 복원된다
  await page.reload(); await ax(page);
  await expect(attachment).toContainText("첨부 파일이 사용됨 — 재분석 시 재첨부 필요");
  await fileInput(page).setInputFiles([csv("입력자료.csv", "품목,수량\n연료,10\n윤활유,3")]);
  await expect(attachment).toContainText("입력자료.csv");
  await expect(attachment).not.toContainText("세션 요약 준비됨");
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("첨부 파일 요약 기반 진단", { exact: false })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect((calls[1].attachmentSummary as string)).not.toContain("[첨부 파일");
});

test("AX multi-file: reattaching the identical file after reload restores the summary without clearing the diagnosis", async ({ page }) => {
  const calls: Record<string, unknown>[] = []; await mock(page, calls);
  await page.goto("/"); await ax(page);
  await fileInput(page).setInputFiles([csv("monthly.csv", "업무,주기\n표취합,매월")]);
  await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("첨부 파일 요약 기반 진단", { exact: false })).toBeVisible();
  // 비동기 저장이 끝나 진단이 실제로 기록된 뒤에 새로고침한다
  await expect.poll(async () => (await record(page))?.tasks[0].diagnosis).toBeDefined();
  await page.reload(); await ax(page);
  const attachment = page.locator(".ax-attachment");
  await expect(attachment).toContainText("첨부 파일이 사용됨 — 재분석 시 재첨부 필요");
  await fileInput(page).setInputFiles([csv("monthly.csv", "업무,주기\n표취합,매월")]);
  await expect(attachment).toContainText("monthly.csv");
  await expect(attachment).not.toContainText("세션 요약 준비됨");
  // 동일 파일 복원만으로는 기존 진단이 초기화되지 않는다
  await expect(page.getByRole("button", { name: "업무 다시 진단" })).toBeVisible();
  const stored = await record(page);
  expect(stored?.tasks[0].diagnosis).toBeDefined();
  expect(stored?.tasks[0].attachmentMetas).toBeUndefined();
  expect(stored?.tasks[0].attachmentMeta?.name).toBe("monthly.csv");
});

test("AX multi-file: rows stay tidy on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await ax(page);
  await fileInput(page).setInputFiles([
    csv("모바일확인용_긴파일명_자료.csv", "항목,값\n모바일,1"),
    csv("두번째.csv", "항목,값\n둘,2"),
  ]);
  await expect(page.locator(".ax-register-files .ax-file-row")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test.describe("AX multi-file at 110% scale", () => {
  test.use({ deviceScaleFactor: 1.1 });
  test("rows and remove buttons stay aligned without overflow", async ({ page }) => {
    await page.goto("/"); await ax(page);
    await fileInput(page).setInputFiles([
      csv("확대확인용_자료.csv", "항목,값\n확대,1"),
      csv("두번째_자료.csv", "항목,값\n둘,2"),
    ]);
    const rows = page.locator(".ax-register-files .ax-file-row");
    await expect(rows).toHaveCount(2);
    const boxes = await rows.evaluateAll(els => els.map(el => {
      const row = el.getBoundingClientRect();
      const button = el.querySelector("button")!.getBoundingClientRect();
      return { rowTop: row.top, rowBottom: row.bottom, buttonTop: button.top, buttonBottom: button.bottom };
    }));
    for (const box of boxes) {
      expect(box.buttonTop).toBeGreaterThanOrEqual(box.rowTop);
      expect(box.buttonBottom).toBeLessThanOrEqual(box.rowBottom + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
