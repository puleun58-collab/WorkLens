import { expect, test, type Locator, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";

// 정보 확인 UI 통일 검증: 문구는 "정보 확인 필요 업무 N개"(업무 수 기준), 링크는 형제 집계 문구와
// 같은 회색·굵기로 표시되고 hover/focus-visible에서만 클릭 가능성을 드러낸다.
// 질문 영역 제목은 "답변할 질문 N개"이며 실제 질문 목록 개수와 일치한다.
// 시드 헬퍼는 ax-counts-unify.spec.ts와 같은 방식(IndexedDB worklens-ax)을 쓴다.
async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function seed(page: Page, value: AxStateV2) {
  await page.evaluate(async state => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(state, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, value);
}
function withDiagnosis(id: string, name: string, mutate: (d: typeof diagnosisFixture) => void): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  mutate(diagnosis);
  return { ...taskFixture(id, diagnosis), name, status: taskStatus(diagnosis) };
}
const conditionalTask = (id: string, name: string) => withDiagnosis(id, name, () => {});
const needsCheckTask = (id: string, name: string, questions: string[]) => withDiagnosis(id, name, d => {
  d.informationSufficiency = "needs-check";
  d.followUpQuestions = questions;
});

async function openAt(page: Page, tasks: AxTask[], step: number, selectedId?: string) {
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: selectedId ?? tasks[0].id, step });
  await ax(page);
}
const matrixCounts = (page: Page) => page.locator(".ax-matrix-counts");
const matrixLink = (page: Page) => matrixCounts(page).getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true });
const resultKpi = (page: Page) => page.locator(".ax-kpi").filter({ has: page.locator(".ax-kpi-label", { hasText: "진단 완료" }) });
const kpiLink = (page: Page) => resultKpi(page).locator("small").getByRole("button", { name: "정보 확인 필요 업무 1개", exact: true });

async function styleOf(locator: Locator) {
  return locator.evaluate(el => {
    const s = getComputedStyle(el);
    return { color: s.color, fontWeight: s.fontWeight, fontSize: s.fontSize, deco: s.textDecorationLine, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
  });
}
async function tabUntilFocused(page: Page, locator: Locator, max = 120) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate(el => el === document.activeElement).catch(() => false)) return;
  }
  throw new Error("키보드 Tab으로 링크에 포커스하지 못했습니다");
}

test("업무 수와 질문 수가 구분된다: 질문 3개인 업무도 정보 확인 필요 업무 1개로 표시된다", async ({ page }) => {
  const target = needsCheckTask("need", "질문 많은 업무", ["질문 1", "질문 2", "질문 3"]);
  await openAt(page, [conditionalTask("cond", "조건부 업무"), target], 3);
  await expect(matrixCounts(page)).toHaveText("진단 완료 2/2 · 확인 후 진행 2 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(resultKpi(page).locator("strong")).toHaveText("2개");
  await expect(resultKpi(page).locator("small")).toHaveText("확인 후 진행 2 · 정보 확인 필요 업무 1개");
});

test("매트릭스 링크 스타일: 기본은 형제 문구와 같은 회색·굵기·크기이고 밑줄이 없다", async ({ page }) => {
  await openAt(page, [needsCheckTask("need", "확인 업무", ["질문"])], 3);
  const link = matrixLink(page);
  await expect(link).toBeVisible();
  const sibling = await styleOf(matrixCounts(page));
  const base = await styleOf(link);
  expect(base.color).toBe(sibling.color);
  expect(base.fontWeight).toBe(sibling.fontWeight);
  expect(base.fontSize).toBe(sibling.fontSize);
  expect(base.deco).toBe("none");
  // Hover: 색상 변화와 밑줄로 클릭 가능 상태를 표현한다.
  await link.hover();
  const hover = await styleOf(link);
  expect(hover.color).not.toBe(base.color);
  expect(hover.deco).toContain("underline");
});

test("매트릭스 링크 스타일: 키보드 포커스 시 focus-visible 아웃라인이 표시된다", async ({ page }) => {
  await openAt(page, [needsCheckTask("need", "확인 업무", ["질문"])], 3);
  const link = matrixLink(page);
  await tabUntilFocused(page, link);
  const focused = await link.evaluate(el => {
    const s = getComputedStyle(el);
    return { matches: el.matches(":focus-visible"), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
  });
  expect(focused.matches).toBe(true);
  expect(focused.outlineStyle).toBe("solid");
  expect(focused.outlineWidth).toBe("2px");
});

test("결과·로드맵 KPI 링크 스타일: 기본은 보조 설명 문구와 같고 hover에서만 강조된다", async ({ page }) => {
  await openAt(page, [needsCheckTask("need", "확인 업무", ["질문"])], 4);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  const link = kpiLink(page);
  await expect(link).toBeVisible();
  const sibling = await styleOf(resultKpi(page).locator("small"));
  const base = await styleOf(link);
  expect(base.color).toBe(sibling.color);
  expect(base.fontWeight).toBe(sibling.fontWeight);
  expect(base.fontSize).toBe(sibling.fontSize);
  expect(base.deco).toBe("none");
  await link.hover();
  const hover = await styleOf(link);
  expect(hover.color).not.toBe(base.color);
  expect(hover.deco).toContain("underline");
});

test("바로가기로 이동하면 질문 영역 제목이 답변할 질문 3개이고 실제 질문 목록과 개수가 일치한다", async ({ page }) => {
  const target = needsCheckTask("need", "운임 정산 업무", ["질문 1", "질문 2", "질문 3"]);
  await openAt(page, [conditionalTask("cond", "조건부 업무"), target], 3);
  await matrixLink(page).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator(".ax-diag-card h2")).toHaveText(target.name);
  const section = page.locator("#ax-answer-section");
  await expect(section).toBeVisible();
  // 제목에 업무명을 중복 표시하지 않고, 제목 숫자와 렌더된 질문 입력란 수가 일치한다.
  await expect(section.locator("h3")).toHaveText("답변할 질문 3개");
  await expect(section.locator("textarea")).toHaveCount(3);
  // 입력한 답변은 단계 전환 후에도 유지된다 (기존 세션 답변 상태).
  await section.locator("textarea").first().fill("담당자 확인 답변");
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(section.locator("textarea").first()).toHaveValue("담당자 확인 답변");
});

test("질문이 1개이면 답변할 질문 1개, 질문이 없으면 질문 영역 자체를 표시하지 않는다", async ({ page }) => {
  const one = needsCheckTask("one", "질문 하나 업무", ["유일한 질문"]);
  await openAt(page, [one], 2, one.id);
  const section = page.locator("#ax-answer-section");
  await expect(section.locator("h3")).toHaveText("답변할 질문 1개");
  await expect(section.locator("textarea")).toHaveCount(1);

  const none = needsCheckTask("none", "질문 없는 업무", []);
  await openAt(page, [none], 2, none.id);
  await expect(page.locator("#ax-answer-section")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /답변할 질문/ })).toHaveCount(0);
});

test.describe("110% 확대 (DSF 1.1)", () => {
  test.use({ deviceScaleFactor: 1.1 });
  test("매트릭스 집계와 링크가 겹침·가로 넘침 없이 표시된다", async ({ page }) => {
    await openAt(page, [conditionalTask("cond", "조건부 업무"), needsCheckTask("need", "확인 업무", ["질문"])], 3);
    await expect(matrixCounts(page)).toHaveText("진단 완료 2/2 · 확인 후 진행 2 · 정보 확인 필요 업무 1개");
    await expect(matrixLink(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("모바일 390×844에서도 두 화면 문구가 일치하고 링크가 동작한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const target = needsCheckTask("need", "모바일 확인 업무", ["질문 1", "질문 2"]);
  await openAt(page, [conditionalTask("cond", "조건부 업무"), target], 3);
  await expect(matrixCounts(page)).toHaveText("진단 완료 2/2 · 확인 후 진행 2 · 정보 확인 필요 업무 1개");
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(resultKpi(page).locator("small")).toHaveText("확인 후 진행 2 · 정보 확인 필요 업무 1개");
  await kpiLink(page).click();
  await expect(page.getByRole("tab", { name: "업무 진단", exact: true })).toHaveAttribute("data-active", "");
  await expect(page.locator("#ax-answer-section").locator("h3")).toHaveText("답변할 질문 2개");
});
