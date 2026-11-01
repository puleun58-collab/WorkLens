import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2 } from "../../src/lib/ax/types";

async function seed(page: Page, state: AxStateV2) {
  await page.goto("/");
  await page.evaluate(async value => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onupgradeneeded = () => req.result.createObjectStore("state"); req.onsuccess = () => resolve(req.result); });
    await new Promise<void>(resolve => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(value, "current"); tx.oncomplete = () => resolve(); });
    db.close();
  }, state);
  await navigateWorkspace(page, "업무 자동화 진단");
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<AxStateV2 | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result as AxStateV2 | undefined); });
    db.close();
    return value;
  });
}

const diagnosis = { ...diagnosisFixture, planCodex: planFixture, decisionGate: { verdict: "go" as const, reasons: [] }, informationSufficiency: "sufficient" as const,
  technicalChecks: [
    { topic: "파일 저장소 접근 권한", status: "확인 필요" as const, note: "공유 드라이브 접근 권한 확인 필요", required: true },
    { topic: "보고서 템플릿 자동화", status: "확인 필요" as const, note: "템플릿 파일 형식 확인 필요", required: true },
  ] };

test("AX 확인 필요 항목: 근거와 함께 확인 완료를 저장하면 건수·Gate·구현 전 확인·지시문에 반영되고, 다른 업무와 섞이지 않으며 새로고침 후 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const a = taskFixture("check-a", diagnosis), b = taskFixture("check-b", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [{ ...a, name: "업무 A" }, { ...b, name: "업무 B" }], selectedTaskId: a.id, step: 2 });
  const card = page.locator(".ax-diag-card");
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 2건");
  await expect(card.locator(".ax-gate-badge")).toHaveText("확인 후 진행");
  const row = card.locator(".ax-diag-checks li").filter({ hasText: "파일 저장소 접근 권한" });
  await row.getByRole("button", { name: "결과 입력" }).click();
  const form = row.getByRole("group", { name: "파일 저장소 접근 권한 확인 결과 입력" });
  await expect(form.getByRole("combobox", { name: "확인 결과" })).toHaveText("미확인");
  await expect(form).not.toContainText("확인이 필요한 내용");
  const textareaBox = await form.getByLabel("확인 내용").boundingBox();
  const inputButtonBox = await row.getByRole("button", { name: "결과 입력" }).boundingBox();
  expect(textareaBox).not.toBeNull();
  expect(inputButtonBox).not.toBeNull();
  expect(Math.abs(textareaBox!.x + textareaBox!.width - inputButtonBox!.x - inputButtonBox!.width), JSON.stringify({ textareaBox, inputButtonBox })).toBeLessThanOrEqual(1);
  // 근거 없이 확인 완료는 저장되지 않는다.
  await form.getByRole("combobox", { name: "확인 결과" }).click();
  await expect(page.getByRole("option")).toHaveText(["확인", "불가", "미확인"]);
  await page.getByRole("option", { name: "확인", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("확인한 내용과 근거를 입력하세요");
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 2건");
  // 미확인 기록은 상태를 바꾸지 않는다.
  await form.getByRole("combobox", { name: "확인 결과" }).click();
  await page.getByRole("option", { name: "미확인", exact: true }).click();
  await form.getByLabel("확인 내용").fill("IT팀에 권한 요청함");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("확인 내용 저장 완료 · 추가 확인 필요");
  await expect(row.locator(".ax-check-badge")).toHaveText("확인 내용 등록");
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 2건");
  // 근거와 함께 확인 완료 → 확인 필요 건수 감소, 확인 완료 목록으로 이동
  await form.getByRole("combobox", { name: "확인 결과" }).click();
  await page.getByRole("option", { name: "확인", exact: true }).click();
  await form.getByLabel("확인 내용").fill("IT팀이 서비스 계정에 읽기·쓰기 권한 부여 확인");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 1건");
  await card.getByRole("button", { name: "확인 완료 항목 보기 (1건)" }).click();
  const doneRow = card.locator(".ax-checks-done li").filter({ hasText: "파일 저장소 접근 권한" });
  await expect(doneRow.locator(".ax-check-badge")).toHaveText("담당자 확인");
  await expect(doneRow).toContainText("담당자 확인: IT팀이 서비스 계정에 읽기·쓰기 권한 부여 확인");
  // 저장 데이터: 원본 진단은 그대로, 업무 A에만 기록
  await expect.poll(async () => (await stored(page))?.tasks.find(task => task.id === a.id)?.checkConfirmations?.length).toBe(1);
  const record = await stored(page);
  expect(record?.tasks.find(task => task.id === a.id)?.diagnosis?.technicalChecks[0].status).toBe("확인 필요");
  expect(record?.tasks.find(task => task.id === a.id)?.checkConfirmations?.[0]?.result).toBe("확인 완료");
  expect(record?.tasks.find(task => task.id === b.id)?.checkConfirmations).toBeUndefined();
  // 새로고침 후 유지
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 1건");
  // 결과·로드맵: 구현 전 확인에서 제외되고, 남은 항목의 '확인하러 가기'는 업무 진단의 해당 입력을 연다.
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  const precheck = plan.getByRole("region", { name: "구현 전 확인", exact: true });
  await precheck.getByRole("button", { name: /구현 전 확인/ }).click();
  await expect(precheck).not.toContainText("파일 저장소 접근 권한");
  // 올인원 지시문에 담당자 확인 근거가 반영된다.
  await plan.getByRole("region", { name: "올인원 지시문", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect(plan.locator(".ax-prompt")).toContainText("IT팀이 서비스 계정에 읽기·쓰기 권한 부여 확인");
  const target = precheck.locator(".ax-precheck-row").filter({ hasText: "보고서 템플릿 자동화" });
  // 한 줄 구성(굵은 항목명 + 확인)이며 보조 설명·확인 위치 문구는 없다.
  await expect(target).not.toContainText("확인 위치");
  await target.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ax-diag-card h2")).toHaveText("업무 A");
  await expect(page.getByRole("group", { name: "보고서 템플릿 자동화 확인 결과 입력" })).toBeVisible();
  // 이동 후 항목 제목이 고정 헤더 아래에 먼저 보인다.
  const title = page.locator(".ax-diag-checks li").filter({ hasText: "보고서 템플릿 자동화" }).locator(".ax-check-text strong");
  await expect.poll(async () => (await title.boundingBox())?.y ?? -1).toBeGreaterThan(60);
  await expect.poll(async () => (await title.boundingBox())?.y ?? 9999).toBeLessThan(220);
  // 업무 B는 영향 없음
  await page.locator('section[aria-label="등록 업무 목록"]').getByRole("button", { name: /업무 B/ }).click();
  await expect(page.locator(".ax-judgement-foot")).toContainText("확인 필요 · 2건");
});
