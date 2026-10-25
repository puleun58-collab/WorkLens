import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxDiagnosis, type AxState } from "../../src/lib/ax/types";

/**
 * AX 잔여 검증 UI 흐름 (HITL 제외 항목 재유입, 수정 후 로컬 빌드 실측).
 * - 진단은 저장소 자체 E2E 시드 방식(IndexedDB 직접 적재)으로 준비하고,
 *   계획 생성의 AI 백엔드만 기존 스펙과 동일하게 /api/ai 모킹으로 대체한다.
 *   HITL 검토·계획 생성 버튼·지시문 렌더링·복사·새로고침 후 재확인은 실제 UI로 수행한다.
 * - 제외 대상: 선택 기술 확인 항목 "이상값 알림 메커니즘" 1개.
 * - 유지 대상: 필수 기술 확인 항목 "파일 파싱 가능 여부" (유지로 확정).
 */

const STEPS = ["원본 파일 읽기", "금액 계산", "납품표 대조", "Excel 보고서 생성"] as const;
const KEPT_TOPIC = "파일 파싱 가능 여부";
const OPT_TOPIC = "이상값 알림 메커니즘";
const OPT_TEXT = "이상값 알림 메커니즘: 확인 필요 - 결측 표시와 알림은 선택 기능";
const KEPT_TEXT = "파일 파싱 가능 여부: 확인 필요 - 엑셀 구조 파악 필요";

const diagnosis: AxDiagnosis = {
  ...diagnosisFixture,
  decisionGate: { verdict: "conditional", reasons: ["기술 확인 후 진행"] },
  stepAssessments: STEPS.map(step => ({ step, verdict: "자동화", owner: "시스템", note: "확정된 규칙으로 처리" })),
  asIs: {
    ...diagnosisFixture.asIs,
    purpose: "거래 금액을 계산하고 결과를 보고",
    inputs: ["거래내역.xlsx"],
    steps: [...STEPS],
    outputs: ["Excel 보고서"],
    exceptions: ["납품표 번호 불일치", "금액 형식 오류", "Excel 파일 손상"],
    systems: ["Excel"],
  },
  poc: {
    ...diagnosisFixture.poc,
    inScope: [...STEPS],
    inputs: ["거래내역.xlsx"],
    outputs: ["Excel 보고서"],
    success: ["계산 결과가 기대값과 일치"],
    failure: ["금액 불일치가 일치로 표시"],
  },
  risks: ["금액 형식 오류"],
  technicalChecks: [
    { topic: KEPT_TOPIC, status: "확인 필요", note: "엑셀 구조 파악 필요", required: true },
    { topic: OPT_TOPIC, status: "확인 필요", note: "결측 표시와 알림은 선택 기능", required: false },
  ],
};

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
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

async function reviewItem(page: Page, itemText: string, action: "exclude" | "keep", reason?: string) {
  const region = page.getByRole("region", { name: "위험·확인사항 검토", exact: true });
  await expect(region).toBeVisible();
  const row = region.locator("tr", { hasText: itemText }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "검토", exact: true }).click();
  const panel = page.locator(".ax-hitl-panel-v2").first();
  await expect(panel).toBeVisible();
  await panel.locator("label", { hasText: action === "exclude" ? "실행 대상에서 제외합니다." : "AI 판단 그대로 적용합니다." }).first().click();
  if (reason) {
    await page.getByLabel(/제외 사유/).fill(reason);
  }
  await panel.getByRole("button", { name: "확정", exact: true }).click();
  // 확정 후 패널은 확인 뷰(내 검토)로 남으므로, 행의 닫기 버튼으로 닫는다.
  await expect(panel.locator(".ax-hitl-confirmed")).toBeVisible();
  await row.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(panel).toHaveCount(0);
}

test("AX HITL 선택 확인 항목 제외가 양 도구 지시문에서 전수 부재하고 새로고침 후에도 유지된다", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-desktop", "잔여 UI 흐름은 데스크톱 Chromium에서만 실측한다.");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const task = taskFixture("hitl-residual-ui", diagnosis);
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await ax(page);
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();

  // 1) HITL: 선택 항목 제외 확정, 필수 항목 유지 확정.
  await reviewItem(page, OPT_TEXT, "exclude", "알림 연동은 이번 범위에서 제외");
  await reviewItem(page, KEPT_TEXT, "keep");
  await expect.poll(async () => {
    const state = await record(page);
    const saved = state?.tasks.find(t => t.id === task.id) as typeof task & { reviews?: Array<{ target: { sourceText: string }; action: string; status: string }> } | undefined;
    return saved?.reviews?.filter(r => r.status === "confirmed").map(r => `${r.target.sourceText}:${r.action}`).sort() ?? [];
  }).toContain(`${OPT_TEXT}:exclude`);

  // 2) 계획 생성 (AI 백엔드만 모킹) → Codex 지시문 화면 원문 + 복사.
  await page.route("**/api/ai", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-plan", plan: planFixture } }) });
  });
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  const codexCopy = page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true });
  await expect(codexCopy).toBeVisible();
  const codexPrompt = page.locator(".ax-prompt").first();
  const codexText = (await codexPrompt.textContent()) ?? "";
  expect(codexText).not.toContain(OPT_TOPIC);
  expect(codexText).toContain(KEPT_TOPIC);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await codexCopy.click();
  await expect(codexCopy).toHaveAttribute("data-copied", "true");
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(codexText.replace(/\r\n/g, "\n"));
  await writeFile("artifacts/ax-hitl-residual-ui-prompt-codex.txt", codexText);

  // 3) Claude Code 계획 생성 → 동일하게 전수 부재·필수 유지 확인.
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Claude Code용 구현 계획 생성", exact: true }).click();
  const claudeCopy = page.getByRole("button", { name: "Claude Code용 올인원 지시문 복사", exact: true });
  await expect(claudeCopy).toBeVisible();
  const claudeText = (await page.locator(".ax-prompt").first().textContent()) ?? "";
  expect(claudeText).not.toContain(OPT_TOPIC);
  expect(claudeText).toContain(KEPT_TOPIC);
  await writeFile("artifacts/ax-hitl-residual-ui-prompt-claude.txt", claudeText);
  await page.screenshot({ path: "artifacts/ax-hitl-residual-ui-prompt.png", fullPage: true });

  // 4) 새로고침 후 저장 기록과 지시문 재확인.
  await page.reload();
  await ax(page);
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  const reloadedText = (await page.locator(".ax-prompt").first().textContent()) ?? "";
  expect(reloadedText).not.toContain(OPT_TOPIC);
  expect(reloadedText).toContain(KEPT_TOPIC);
  expect(reloadedText).toBe(codexText);
  const savedAfter = await record(page);
  const savedTask = savedAfter?.tasks.find(t => t.id === task.id) as typeof task & { reviews?: Array<{ target: { sourceText: string }; action: string; status: string }> } | undefined;
  expect(savedTask?.reviews?.some(r => r.target.sourceText === OPT_TEXT && r.action === "exclude" && r.status === "confirmed")).toBe(true);
});
