import { expect, test, type Locator, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxTask } from "../../src/lib/ax/types";
import { executionGate, priority, taskStatus } from "../../src/lib/ax/policy";

type Kind = "ready" | "conditional" | "blocked" | "questions";
// 110% browser zoom lays out like a 1440/1.1 CSS-pixel viewport.
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 1309, height: 818 }] as const;

function make(id: string, values: number[], kind: Kind, plans = false): AxTask {
  const d: AxDiagnosis = structuredClone(diagnosisFixture);
  d.factors = d.factors.map((factor, index) => ({ ...factor, aiValue: values[index] }));
  if (kind === "ready") { d.decisionGate = { verdict: "go", reasons: [] }; d.technicalChecks = [{ topic: "시스템 접근", status: "확인됨", note: "읽기 권한 확인" }]; }
  if (kind === "blocked") d.decisionGate = { verdict: "no-go", reasons: ["보안 정책상 자료 반출 불가"] };
  if (kind === "questions") { d.informationSufficiency = "needs-check"; d.followUpQuestions = ["입력 자료 형식을 알려 주세요"]; }
  const diagnosis = plans ? { ...d, planCodex: planFixture, planClaude: planFixture } : d;
  return { ...taskFixture(id, diagnosis), name: `업무 ${id}`, status: taskStatus(diagnosis) };
}
async function open(page: Page, tasks: AxTask[], step: number, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto("/");
  await page.evaluate(async state => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(state, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, { ...emptyAxState(), tasks, selectedTaskId: tasks[0].id, step });
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("worklens-ax", 1); r.onsuccess = () => resolve(r.result); });
    const value = await new Promise<{ selectedTaskId: string | null; tasks: { id: string; reviews?: { supplement?: string; status: string }[] }[] }>(resolve => { const r = db.transaction("state").objectStore("state").get("current"); r.onsuccess = () => resolve(r.result); });
    db.close(); return value;
  });
}
/** Vertical-centre offsets (px) inside one HITL panel; every pair must share a centre line. */
async function hitlOffsets(panel: Locator) {
  return panel.evaluate(root => {
    const mid = (element: Element | null) => { const r = element!.getBoundingClientRect(); return r.top + r.height / 2; };
    let action = 0;
    for (const item of root.querySelectorAll(".ax-hitl-v2-action")) {
      const base = mid(item.querySelector(".ax-hitl-v2-action-label"));
      action = Math.max(action, Math.abs(base - mid(item.querySelector("input"))), Math.abs(base - mid(item.querySelector(".ax-hitl-v2-action-desc"))));
    }
    const notice = root.querySelector(".ax-hitl-v2-notice")!;
    const box = notice.getBoundingClientRect(), style = getComputedStyle(notice);
    const top = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const bottom = box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const centre = (top + bottom) / 2;
    return {
      head: Math.abs(mid(root.querySelector(".ax-hitl-v2-title")) - mid(root.querySelector(".ax-hitl-v2-subtitle"))),
      original: Math.abs(mid(root.querySelector(".ax-hitl-v2-original-title")) - mid(root.querySelector(".ax-hitl-v2-original-sub"))),
      action,
      noticeIcon: Math.abs(mid(notice.querySelector(".ax-hitl-v2-notice-icon")) - centre),
      noticeText: Math.abs(mid(notice.querySelector(".ax-hitl-v2-notice-icon + span")) - centre),
    };
  });
}
async function expectAligned(panel: Locator) {
  for (const [part, offset] of Object.entries(await hitlOffsets(panel))) expect(offset, part).toBeLessThanOrEqual(1.5);
}

for (const viewport of VIEWPORTS) {
  test(`AX HITL review areas share centre alignment and keep saved decisions at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const task = make("hitl", [4, 4, 4, 4, 2, 2], "conditional", true);
    await open(page, [task], 2, viewport);
    const steps = page.getByRole("region", { name: "단계별 자동화 판단", exact: true });
    const table = steps.locator(".ax-hitl-step-table");
    await expect(table.locator("thead th")).toHaveText(["업무 단계", "판정", "담당", "판단 근거", "상태", "작업"]);
    const first = table.locator("tbody > tr").first();
    if (viewport.width > 700) {
      const widths = await table.locator("thead th").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
      expect(widths[2]).toBeLessThan(widths[1]);
      expect(widths[3]).toBeGreaterThan(widths[2] * 3);
      expect(await first.locator("td").nth(3).evaluate(element => element.getClientRects().length === 1 && element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await first.getByRole("button", { name: "검토", exact: true }).click();
    const stepPanel = steps.locator(".ax-hitl-panel-v2");
    await expectAligned(stepPanel);
    await stepPanel.getByRole("radio", { name: /보완/ }).check();
    await expectAligned(stepPanel);
    await stepPanel.getByLabel("보완 내용", { exact: false }).fill("누락 행은 삭제하지 않고 별도 검토 결과로 표시");
    await stepPanel.getByRole("button", { name: "확정", exact: true }).click();
    await expect(first.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
    await expect(steps.locator(".ax-hitl-table-counts")).toContainText("검토 전 2");
    await expect.poll(async () => (await stored(page)).tasks[0].reviews?.[0]?.supplement).toBe("누락 행은 삭제하지 않고 별도 검토 결과로 표시");

    const risks = page.getByRole("region", { name: "위험·확인사항 검토", exact: true });
    await risks.getByRole("button", { name: "검토", exact: true }).first().click();
    await expectAligned(risks.locator(".ax-hitl-panel-v2"));
    await risks.getByRole("button", { name: "취소", exact: true }).click();
    await expect(risks.locator(".ax-hitl-panel-v2")).toHaveCount(0);

    await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
    const plan = page.getByRole("region", { name: "구현 계획 검토", exact: true });
    await plan.getByRole("button", { name: "검토", exact: true }).first().click();
    await expectAligned(plan.locator(".ax-hitl-panel-v2"));
    await plan.locator(".ax-hitl-panel-v2").screenshot({ path: `artifacts/ax/hitl-plan-review-${viewport.width}.png` });

    // The confirmed step decision reaches the generated all-in-one instruction.
    await expect(page.locator(".ax-prompt")).toContainText("누락 행은 삭제하지 않고 별도 검토 결과로 표시");
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
    await expect(first.locator(".ax-hitl-status-dot")).toHaveAttribute("data-status", "confirmed");
    await first.getByRole("button", { name: "보기", exact: true }).click();
    await expect(steps.locator(".ax-hitl-confirmed")).toContainText("누락 행은 삭제하지 않고 별도 검토 결과로 표시");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await steps.screenshot({ path: `artifacts/ax/hitl-step-table-${viewport.width}.png` });
  });
}

const mixed = [
  make("ready", [5, 5, 5, 5, 1, 1], "ready"),
  make("cond-a", [4, 4, 4, 4, 2, 2], "conditional"),
  make("blocked", [4, 4, 4, 3, 2, 2], "blocked"),
  make("questions", [3, 4, 3, 3, 2, 2], "questions"),
  make("cond-b", [3, 3, 3, 3, 3, 2], "conditional"),
];
for (const viewport of VIEWPORTS) {
  test(`AX matrix counts, colours, help, single selection and top-three priority at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await open(page, mixed, 3, viewport);
    const ranked = priority(mixed);
    const gates = mixed.map(task => executionGate(task.diagnosis!));
    const count = (gate: string) => gates.filter(value => value === gate).length;
    await expect(page.locator(".ax-matrix-header .ax-matrix-counts")).toHaveText(
      `등록 5개 · 진단 완료 5개 (진행 가능 ${count("ready")}개 · 확인 후 진행 ${count("conditional")}개 · 진행 보류 ${count("blocked")}개) · 추가 질문 필요 1개`);

    const list = page.getByLabel("매트릭스 업무 목록");
    for (const [index, row] of ranked.entries()) {
      const item = list.getByRole("listitem").filter({ hasText: row.task.name });
      await expect(item.locator(".ax-task-name")).toHaveText(`${index + 1}. ${row.task.name}`);
      await expect(item.locator(".ax-gate-badge")).toHaveAttribute("data-gate", executionGate(row.task.diagnosis));
    }
    // Comparison selection is gone; single selection remains.
    const step3 = page.locator(".ax-step3-rows");
    await expect(step3.getByRole("checkbox")).toHaveCount(0);
    await expect(step3.getByText(/비교 선택|선택 초기화/)).toHaveCount(0);
    await page.getByRole("button", { name: "보기 옵션" }).click();
    await expect(page.getByRole("menuitemcheckbox")).toHaveText(["점수 표시"]);
    await page.keyboard.press("Escape");

    // Task list is fixed in priority order; filter/sort controls were removed.
    await expect(list.getByLabel("업무 목록 정렬")).toHaveCount(0);
    await expect(list.getByLabel("Gate 상태별 조회")).toHaveCount(0);

    // Help: headings and body share one left edge, no bullets.
    await page.getByRole("button", { name: "도움말" }).click();
    const help = page.getByRole("note", { name: "매트릭스 도움말" });
    await expect(help.locator("li")).toHaveCount(0);
    for (const column of await help.locator(":scope > div").all()) {
      const lefts = await column.locator("h4, p").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
      for (const left of lefts) expect(Math.abs(left - lefts[0])).toBeLessThanOrEqual(1);
    }

    // One colour per gate across legend, bubble status dot and badges.
    for (const gate of ["ready", "conditional", "blocked"] as const) {
      const legend = await page.locator(`.ax-legend-dot[data-gate=${gate}]`).evaluate(element => getComputedStyle(element).backgroundColor);
      expect(await page.locator(`.ax-bubble-gate[data-gate=${gate}]`).first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe(legend);
      expect(await list.locator(`.ax-gate-badge[data-gate=${gate}]`).first().evaluate(element => getComputedStyle(element).color)).toBe(legend);
    }
    const legendColours = await page.locator(".ax-legend-dot").evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
    expect(new Set(legendColours).size).toBe(3);

    // Priority sits between the matrix and the detail, shows the top three ranks and opens the detail.
    const priorityRegion = page.getByRole("region", { name: "자동화 우선순위", exact: true });
    const detail = page.locator(".ax-matrix-detail");
    const order = await page.evaluate(() => [".ax-matrix-surface", ".ax-matrix-priority", ".ax-matrix-detail"].map(selector => document.querySelector(selector)!.getBoundingClientRect().top + scrollY));
    expect(order[0]).toBeLessThan(order[1]); expect(order[1]).toBeLessThan(order[2]);
    await expect(priorityRegion.getByRole("heading", { level: 3 })).toHaveText("자동화 우선순위");
    const top = priorityRegion.getByRole("list", { name: "자동화 우선순위 목록" });
    await expect(top.locator(".ax-rank")).toHaveText(["#1", "#2", "#3"]);
    await expect(top.locator(".ax-task-name")).toHaveText(ranked.slice(0, 3).map(row => row.task.name));
    const third = ranked[2].task;
    await top.getByRole("button", { name: new RegExp(third.name) }).click();
    await expect.poll(async () => (await stored(page)).selectedTaskId).toBe(third.id);
    await expect(detail.locator("h3").first()).toHaveText(third.name);
    await expect.poll(() => detail.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 24, box.top + 24);
      return box.top >= 0 && box.top < innerHeight && !!hit && element.contains(hit);
    })).toBe(true);
    // The selected task is either its own bubble or a member of an overlapping cluster.
    const bubble = page.locator(`.ax-bubble[aria-label^="${third.name} ·"]`);
    if (await bubble.count()) await expect(bubble).toHaveAttribute("aria-pressed", "true");
    else await expect(page.locator('.ax-matrix-cluster[data-selected="true"]')).toHaveCount(1);
    if (executionGate(third.diagnosis!) !== "ready") {
      const basis = detail.getByRole("definition").first();
      await expect(detail.locator(".ax-gate-basis dt")).toHaveText(["진행 상태", "판정 근거", "현재 가능 범위", "다음 조치"]);
      await expect(basis.locator(".ax-gate-badge")).toHaveAttribute("data-gate", executionGate(third.diagnosis!));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `artifacts/ax/matrix-priority-${viewport.width}.png`, fullPage: true });
  });
}

for (const [name, tasks, heading] of [
  ["conditional only", [make("c1", [4, 4, 4, 4, 2, 2], "conditional"), make("c2", [3, 3, 3, 3, 3, 2], "conditional")], "자동화 우선 검토순위"],
  ["all blocked", [make("b1", [4, 4, 4, 4, 2, 2], "blocked"), make("b2", [3, 3, 3, 3, 3, 2], "blocked")], "진행 보류 업무 · 점수순"],
] as const) {
  test(`AX matrix priority heading reflects gate state: ${name}`, async ({ page }) => {
    await open(page, [...tasks], 3, VIEWPORTS[0]);
    const region = page.getByRole("region", { name: "자동화 우선순위", exact: true });
    await expect(region.getByRole("heading", { level: 3 })).toHaveText(heading);
    await expect(region.locator(".ax-gate-badge")).toHaveCount(tasks.length);
  });
}
