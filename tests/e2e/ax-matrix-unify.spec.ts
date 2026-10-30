import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxStateV2, type AxTask } from "../../src/lib/ax/types";
import { taskStatus } from "../../src/lib/ax/policy";

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
function make(id: string, name: string, factors: Partial<Record<AxDiagnosis["factors"][number]["key"], number>>, gate: "ready" | "conditional" | "blocked" = "conditional", needsCheck = false): AxTask {
  const diagnosis = structuredClone(diagnosisFixture);
  diagnosis.factors = diagnosis.factors.map(factor => ({ ...factor, aiValue: factors[factor.key] ?? factor.aiValue }));
  if (gate === "ready") { diagnosis.decisionGate = { verdict: "go", reasons: [] }; diagnosis.technicalChecks = [{ topic: "시스템 접근", status: "확인됨", note: "읽기 권한 확인" }]; }
  if (gate === "blocked") diagnosis.decisionGate = { verdict: "no-go", reasons: ["보안 정책상 자료 반출 불가"] };
  if (needsCheck) { diagnosis.informationSufficiency = "needs-check"; diagnosis.followUpQuestions = ["입력 자료 형식을 알려 주세요"]; }
  return { ...taskFixture(id, diagnosis), name, status: taskStatus(diagnosis) };
}
async function openStep(page: Page, tasks: AxTask[], step: number, width = 1440) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step });
  await ax(page);
}

test("Matrix header, legend and region subtitles match the reference", async ({ page }) => {
  const tasks = [make("h-a", "업무 A", {}), make("h-b", "업무 B", { systemAccess: 1 })];
  await openStep(page, tasks, 3);
  const header = page.locator(".ax-matrix-header");
  await expect(header.getByRole("heading", { name: "자동화 매트릭스" })).toBeVisible();
  await expect(header.locator(".ax-matrix-desc")).toHaveText("업무별 자동화 가치와 기술 실현 가능성을 한눈에 비교할 수 있습니다.");
  // 범례는 헤더 우측에 있다.
  const legend = header.locator(".ax-matrix-legend");
  await expect(legend.locator(".ax-legend-item")).toHaveText(["진행 가능", "확인 후 진행", "진행 보류"]);
  await expect(header.locator(".ax-matrix-counts")).toContainText("진단 완료 2/2");
  // 4분면 지역명 + 부제.
  await expect(page.locator('.ax-region[data-region="strategic"]')).toContainText("전략 과제");
  await expect(page.locator('.ax-region[data-region="strategic"]')).toContainText("가치 높음 · 실현 낮음");
  await expect(page.locator('.ax-region[data-region="strategic"]')).toContainText("(검토 후 추진)");
  await expect(page.locator('.ax-region[data-region="quick"]')).toContainText("빠른 실행 후보");
  await expect(page.locator('.ax-region[data-region="quick"]')).toContainText("(우선 추진)");
  await expect(page.locator('.ax-region[data-region="hold"]')).toContainText("수동 유지·보류");
  await expect(page.locator('.ax-region[data-region="hold"]')).toContainText("(보류 또는 제외)");
  await expect(page.locator('.ax-region[data-region="maybe"]')).toContainText("검토 후보");
  await expect(page.locator('.ax-region[data-region="maybe"]')).toContainText("(부분 자동화 검토)");
});

test("Desktop layout puts the graph left of the list; mobile stacks graph above list", async ({ page }) => {
  const tasks = [make("l-a", "업무 A", {}), make("l-b", "업무 B", { systemAccess: 1 })];
  await openStep(page, tasks, 3, 1440);
  const surface = await page.locator(".ax-matrix-surface").boundingBox();
  const taskcol = await page.locator(".ax-step3-taskcol").boundingBox();
  expect(surface!.x).toBeLessThan(taskcol!.x);
  expect(surface!.width).toBeGreaterThan(taskcol!.width);
  await page.setViewportSize({ width: 390, height: 844 });
  const surfaceM = await page.locator(".ax-matrix-surface").boundingBox();
  const taskcolM = await page.locator(".ax-step3-taskcol").boundingBox();
  expect(surfaceM!.y + surfaceM!.height).toBeLessThanOrEqual(taskcolM!.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Single markers are uniform gate-coloured dots with legend colours", async ({ page }) => {
  const tasks = [
    make("m-ready", "진행 업무", { repetition: 5, regularity: 5, dataStructure: 5, systemAccess: 5, humanJudgment: 1, operationalRisk: 1 }, "ready"),
    make("m-cond", "확인 업무", {}, "conditional"),
    make("m-blocked", "보류 업무", { repetition: 3, regularity: 3, dataStructure: 3, systemAccess: 3, humanJudgment: 3, operationalRisk: 2 }, "blocked"),
  ];
  await openStep(page, tasks, 3);
  await expect(page.locator(".ax-bubble")).toHaveCount(3);
  await expect(page.locator(".ax-bubble")).toHaveText(["", "", ""]);
  await expect(page.locator(".ax-bubble-rank")).toHaveCount(0);
  const dots = await page.locator(".ax-bubble-dot").evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height), bg: getComputedStyle(element).backgroundColor, gate: element.getAttribute("data-gate") };
  }));
  expect(dots.map(dot => `${dot.w}x${dot.h}`)).toEqual(["16x16", "16x16", "16x16"]);
  expect(new Set(dots.map(dot => dot.gate))).toEqual(new Set(["ready", "conditional", "blocked"]));
  for (const dot of dots) {
    const legend = await page.locator(`.ax-legend-dot[data-gate=${dot.gate}]`).evaluate(element => getComputedStyle(element).backgroundColor);
    expect(dot.bg).toBe(legend);
  }
  // 선택 마커만 pressed이고, 선택이 바뀌면 링이 따라간다.
  const markers = page.locator(".ax-bubble");
  await expect(markers.nth(0)).toHaveAttribute("aria-pressed", "true");
  await markers.nth(1).click();
  await expect(markers.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(markers.nth(0)).toHaveAttribute("aria-pressed", "false");
});

test("Diagnosis left list cards share one box spec and keep size on selection", async ({ page }) => {
  const tasks = [
    taskFixture("c-reg"),
    make("c-need", "업무 B", { repetition: 3, regularity: 3, dataStructure: 3, systemAccess: 1, humanJudgment: 2, operationalRisk: 2 }, "conditional", true),
    make("c-diag", "업무 C", {}),
  ];
  await openStep(page, tasks, 2);
  const list = page.getByLabel("등록 업무 목록", { exact: true });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  // 2줄 구조: 1줄 상태 점+업무명, 2줄 진단 상태·Level (지시문 §7 예시 문구).
  await expect(rows.filter({ hasText: "업무 B" })).toContainText("정보 확인 필요 · AI 보조 (Level 1)");
  const boxOf = (index: number) => rows.nth(index).evaluate(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const dot = element.querySelector(".ax-dot")!.getBoundingClientRect();
    const name = element.querySelector(".ax-task-name")!.getBoundingClientRect();
    return { h: Math.round(box.height), border: style.borderTopWidth, radius: style.borderRadius, pad: style.paddingTop,
      dotX: Math.round(dot.x), nameX: Math.round(name.x),
      dotMid: dot.y + dot.height / 2, nameMid: name.y + name.height / 2 };
  });
  const before = [await boxOf(0), await boxOf(1), await boxOf(2)];
  expect(new Set(before.map(box => box.h)).size).toBe(1);
  expect(new Set(before.map(box => box.border)).size).toBe(1);
  expect(new Set(before.map(box => box.radius)).size).toBe(1);
  expect(new Set(before.map(box => box.pad)).size).toBe(1);
  expect(new Set(before.map(box => box.dotX)).size).toBe(1);
  expect(new Set(before.map(box => box.nameX)).size).toBe(1);
  for (const box of before) expect(Math.abs(box.dotMid - box.nameMid)).toBeLessThanOrEqual(4);
  // 선택해도 크기가 변하지 않고 배경·테두리 색으로만 구분된다.
  await rows.filter({ hasText: "업무 B" }).getByRole("button").click();
  const after = [await boxOf(0), await boxOf(1), await boxOf(2)];
  expect(after.map(box => box.h)).toEqual(before.map(box => box.h));
  expect(after.map(box => box.pad)).toEqual(before.map(box => box.pad));
  const styles = await rows.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { bg: style.backgroundColor, border: style.borderTopColor };
  }));
  expect(styles[1].bg).not.toBe(styles[0].bg);
  expect(styles[1].border).not.toBe(styles[0].border);
});

test("Result and roadmap list shows name, Level and next action without gate badges", async ({ page }) => {
  const tasks = [make("r-a", "업무 A", {}), make("r-b", "업무 B", { systemAccess: 1 })];
  await openStep(page, tasks, 4);
  const overview = page.locator(".ax-step4-overview");
  await expect(overview.locator(".ax-gate-badge")).toHaveCount(0);
  const rows = overview.getByRole("listitem");
  await expect(rows.first().locator(".ax-rank")).toHaveText("#1");
  for (const row of await rows.all()) {
    await expect(row.locator(".ax-task-name")).not.toBeEmpty();
    await expect(row).toContainText("Level");
    await expect(row.locator(".ax-next-action")).not.toBeEmpty();
  }
});

test("Gate-mixed group marker carries no single gate colour; panel rows show each gate", async ({ page }) => {
  const ready = make("g-ready", "진행 업무", {}, "ready");
  const blocked = make("g-blocked", "보류 업무", {}, "blocked");
  await openStep(page, [ready, blocked], 3);
  const trigger = page.getByRole("button", { name: "해당 위치의 업무 2건", exact: true });
  await expect(trigger).toHaveCount(1);
  await expect(trigger).not.toHaveAttribute("data-gate", /./);
  await trigger.click();
  const panel = page.getByRole("region", { name: "선택 좌표의 업무 2건", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  await expect(panel.locator("tbody tr").nth(0).locator(".ax-gate-dot")).toHaveAttribute("data-gate", "ready");
  await expect(panel.locator("tbody tr").nth(0)).toContainText("진행 가능");
  await expect(panel.locator("tbody tr").nth(1).locator(".ax-gate-dot")).toHaveAttribute("data-gate", "blocked");
  await expect(panel.locator("tbody tr").nth(1)).toContainText("진행 보류");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
