import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxTask, type HitlReview } from "../../src/lib/ax/types";
import { extractReviewableItems, type ReviewableItem } from "../../src/lib/ax/hitl";
import { taskStatus } from "../../src/lib/ax/policy";

/** HITL 상태·집계 정확성: 단계별 판단과 위험 검토가 구현 계획 검토와 같은 유효성 기준을 쓰는지,
 * 그리고 진단 요약이 담당자 수행·검토·승인을 구분하는지 데스크톱/모바일에서 검증한다. */
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;

function seededTask(): { task: AxTask; stepTotal: number; riskTotal: number } {
  const d: AxDiagnosis = structuredClone(diagnosisFixture);
  d.risks = ["누락 데이터", "권한 없는 자료 접근"];
  const items = extractReviewableItems(d);
  const stepItems = items.filter(i => i.type === "step");
  const riskItems = items.filter(i => i.type === "risk");
  const reviewFor = (item: ReviewableItem, status: HitlReview["status"], sourceHash = item.sourceHash): HitlReview => ({
    id: `seed-${item.key}`,
    target: { key: item.key, type: item.type, source: item.source, sourceText: item.text, sourceHash },
    action: "keep",
    status,
    reviewedAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  });
  const reviews: HitlReview[] = [
    reviewFor(stepItems[0], "confirmed"), // 유효한 확정 → 검토 완료
    reviewFor(stepItems[1], "editing"), // 보완 중
    reviewFor(stepItems[2], "confirmed", "0".repeat(64)), // 원본 불일치 확정 → 재확인 필요
    reviewFor(riskItems[0], "stale"), // 재확인 필요
    // 나머지 위험 항목은 기록 없음 → 검토 전
  ];
  const task = { ...taskFixture("accuracy", d), name: "업무 accuracy", status: taskStatus(d), reviews } as AxTask;
  return { task, stepTotal: stepItems.length, riskTotal: riskItems.length };
}

async function open(page: Page, task: AxTask, viewport: { width: number; height: number }) {
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
  }, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}

async function expectCounts(page: Page, totals: { stepTotal: number; riskTotal: number }) {
  const steps = page.getByRole("region", { name: "단계별 자동화 판단", exact: true });
  const stepCounts = steps.locator(".ax-hitl-table-counts");
  await expect(stepCounts).toContainText(`전체 ${totals.stepTotal}`);
  await expect(stepCounts).toContainText("검토 완료 1");
  await expect(stepCounts).toContainText(`검토 필요 ${totals.stepTotal - 1}`);
  await expect(stepCounts).not.toContainText("검토 전");
  const stepDots = steps.locator(".ax-hitl-step-table .ax-hitl-status-dot");
  await expect(stepDots.nth(0)).toHaveAttribute("data-status", "confirmed");
  await expect(stepDots.nth(0)).toHaveText("검토 완료");
  await expect(stepDots.nth(1)).toHaveAttribute("data-status", "editing");
  await expect(stepDots.nth(1)).toHaveText("보완 중");
  await expect(stepDots.nth(2)).toHaveAttribute("data-status", "stale");
  await expect(stepDots.nth(2)).toHaveText("재확인 필요");

  const risks = page.getByRole("region", { name: "위험·확인사항 검토", exact: true });
  const riskCounts = risks.locator(".ax-hitl-table-counts");
  await expect(riskCounts).toContainText(`전체 ${totals.riskTotal}`);
  await expect(riskCounts).toContainText("검토 완료 0");
  await expect(riskCounts).toContainText(`검토 필요 ${totals.riskTotal}`);
  await expect(riskCounts).not.toContainText("검토 전");
  const riskDots = risks.locator(".ax-hitl-table .ax-hitl-status-dot");
  await expect(riskDots).toHaveCount(totals.riskTotal);
  await expect(riskDots.nth(0)).toHaveAttribute("data-status", "stale");
  await expect(riskDots.nth(0)).toHaveText("재확인 필요");
  for (let i = 1; i < totals.riskTotal; i++) {
    await expect(riskDots.nth(i)).toHaveAttribute("data-status", "pending");
    await expect(riskDots.nth(i)).toHaveText("검토 전");
  }
  return steps;
}

for (const viewport of VIEWPORTS) {
  test(`HITL status counts and summary roles stay accurate at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const seeded = seededTask();
    await open(page, seeded.task, viewport);

    // 진단 요약: 수행 단계와 명시된 승인 지점을 구분하고 결합 문구를 만들지 않는다.
    const summary = page.locator(".ax-diag-summary");
    await expect(summary).toContainText("담당자 승인 단계는 담당자가 직접 수행해야 합니다.");
    await expect(summary).toContainText("담당자 최종 승인 지점에서는 담당자 승인이 필요합니다.");
    await expect(summary).not.toContainText("판단·승인이 필요합니다");

    const steps = await expectCounts(page, seeded);
    await steps.screenshot({ path: `artifacts/ax/hitl-accuracy-steps-${viewport.width}.png` });

    // 저장·새로고침·재조회 후에도 상태와 건수가 같다.
    await page.reload();
    await navigateWorkspace(page, "업무 자동화 진단");
    await expectCounts(page, seeded);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
