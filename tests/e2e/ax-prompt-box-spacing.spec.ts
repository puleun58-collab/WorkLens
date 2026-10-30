import { expect, test, type Locator, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTask } from "../../src/lib/ax/types";

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

async function openGuide(page: Page) {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture };
  const task: AxTask = { ...taskFixture("guide-a", diagnosis), name: "프롬프트 박스 간격 확인 업무" };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(plan).toBeVisible();
  const trigger = plan.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return plan.locator(".ax-guide-panel");
}

function sectionCode(panel: Locator, stepNo: number, heading: string) {
  const tutorial = panel.locator(".ax-setup-tutorial");
  const step = tutorial.locator(`.ax-guide-step[data-setup-step="${stepNo}"]`);
  const section = step.locator(".ax-guide-section").filter({ hasText: heading });
  return section.locator(".ax-guide-code").first();
}

function guideSection(panel: Locator, stepNo: number, heading: string) {
  const tutorial = panel.locator(".ax-setup-tutorial");
  const step = tutorial.locator(`.ax-guide-step[data-setup-step="${stepNo}"]`);
  return step.locator(".ax-guide-section").filter({ hasText: heading });
}

type BoxMetrics = {
  text: string;
  blankLines: number;
  height: number;
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
};

/** Read a code box's display text and box metrics in one synchronous read. */
async function measure(box: Locator): Promise<BoxMetrics> {
  await box.scrollIntoViewIfNeeded();
  const handle = await box.elementHandle();
  expect(handle).not.toBeNull();
  return box.evaluate(el => {
    const code = el.querySelector("code");
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const text = code?.textContent ?? "";
    return {
      text,
      blankLines: text.split("\n").filter(line => line.trim() === "").length,
      height: Math.round(rect.height),
      lineHeight: Number.parseFloat(style.lineHeight),
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
    };
  });
}

const STEP07_REQUEST_START = "현재 프로젝트의 구조, GitHub 연결 상태, 배포 서비스 및 기존 배포 설정을 먼저 확인해 줘.";
// STEP 08 검증 요청 문구는 MVP 검증→수정 흐름 개선에서 9개 필수 확인 항목으로 정밀화됐다 (의도된 변경).
const STEP08_REQUEST_START = "완성한 프로그램을 실제 사용 상황처럼 직접 실행해 테스트해 줘.";

test("STEP 07 PR·CI box shows no repeated blank lines", async ({ page }) => {
  const panel = await openGuide(page);
  const box = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  await expect(box).toBeVisible();
  const metrics = await measure(box);
  expect(metrics.text).toContain(STEP07_REQUEST_START);
  expect(metrics.blankLines).toBe(0);
});

test("STEP 08 verification-request box shows no repeated blank lines", async ({ page }) => {
  const panel = await openGuide(page);
  const box = sectionCode(panel, 8, "AI 코딩 에이전트에게 기능 검증 요청");
  await expect(box).toBeVisible();
  const metrics = await measure(box);
  expect(metrics.text).toContain(STEP08_REQUEST_START);
  expect(metrics.blankLines).toBe(0);
});

test("STEP 07 and STEP 08 boxes share line-height and vertical padding", async ({ page }) => {
  const panel = await openGuide(page);
  const box07 = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  const box08 = sectionCode(panel, 8, "AI 코딩 에이전트에게 기능 검증 요청");
  const [m07, m08] = [await measure(box07), await measure(box08)];
  expect(m07.lineHeight).toBe(m08.lineHeight);
  expect(m07.paddingTop).toBe(m08.paddingTop);
  expect(m07.paddingBottom).toBe(m08.paddingBottom);
});

test("STEP 07 copy keeps the original request text including blank lines", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard read is Chromium-only in Playwright");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const panel = await openGuide(page);
  const section = guideSection(panel, 7, "PR·CI 및 배포 확인");
  const copyButton = section.locator(".ax-guide-code-wrap > .ax-guide-copy-button");
  await copyButton.scrollIntoViewIfNeeded();
  await copyButton.click();
  await expect(copyButton).toHaveAttribute("data-copied", "true");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  // Display collapses blank lines, but the copied original keeps them.
  expect(clipboard).toContain(STEP07_REQUEST_START);
  expect(clipboard.split("\n").filter(line => line.trim() === "").length).toBeGreaterThan(0);
  expect(clipboard).toContain("배포가 실행되지 않았거나 실제 반영 여부를 확인하지 못했다면 완료로 표시하지 마.");
});

test("prompt boxes do not overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openGuide(page);
  const box07 = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  await expect(box07).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// --- STEP 07 PR·CI continuous display (box-wrap) ---

const STEP07_SENTENCE_BOUNDARIES = [
  "먼저 확인해 줘. Vercel 또는",
  "우선 유지해 줘. GitHub 연동",
  "검증해 줘. CLI 직접",
  "하지 마. 배포 전",
  "요청해 줘. 기존 데이터와",
  "진행해 줘. 완료 후",
  "보고해 줘. 배포가 실행되지",
];

async function measureStyle(box: Locator) {
  await box.scrollIntoViewIfNeeded();
  return box.evaluate(el => {
    const style = getComputedStyle(el);
    return {
      height: Math.round(el.getBoundingClientRect().height),
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      paddingTop: Number.parseFloat(style.paddingTop),
      paddingBottom: Number.parseFloat(style.paddingBottom),
    };
  });
}

test("STEP 07 PR·CI box displays sentences continuously without forced line breaks", async ({ page }) => {
  const panel = await openGuide(page);
  const box = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  await expect(box).toBeVisible();
  const metrics = await measure(box);
  expect(metrics.text).not.toContain("\n");
  for (const boundary of STEP07_SENTENCE_BOUNDARIES) expect(metrics.text).toContain(boundary);
});

test("STEP 07 PR·CI box is shorter than its #329 forced-line-break height", async ({ page }) => {
  // The 229px baseline is a 1440px-viewport figure (8 forced lines); pin the
  // viewport so this assertion is identical across Playwright projects.
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await openGuide(page);
  const box = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  await expect(box).toBeVisible();
  const metrics = await measure(box);
  expect(metrics.height).toBeLessThan(229);
});

test("STEP 07 and STEP 08 boxes share font size, line-height and padding", async ({ page }) => {
  const panel = await openGuide(page);
  const [m07, m08] = [
    await measureStyle(sectionCode(panel, 7, "PR·CI 및 배포 확인")),
    await measureStyle(sectionCode(panel, 8, "AI 코딩 에이전트에게 기능 검증 요청")),
  ];
  expect(m07.fontSize).toBe(m08.fontSize);
  expect(m07.lineHeight).toBe(m08.lineHeight);
  expect(m07.paddingTop).toBe(m08.paddingTop);
  expect(m07.paddingBottom).toBe(m08.paddingBottom);
});

test("STEP 07 command box keeps its line breaks and STEP 08 box is unchanged", async ({ page }) => {
  const panel = await openGuide(page);
  const commands = sectionCode(panel, 7, "안전하게 Git에 저장");
  await expect(commands).toBeVisible();
  const commandMetrics = await measure(commands);
  expect(commandMetrics.text).toBe(
    ["git status", "git add .", "git diff --cached", 'git commit -m "변경 사항 반영"', "git push"].join("\n"),
  );
  const box08 = sectionCode(panel, 8, "AI 코딩 에이전트에게 기능 검증 요청");
  await expect(box08).toBeVisible();
  const metrics08 = await measure(box08);
  expect(metrics08.text).not.toContain("\n");
  expect(metrics08.text).toContain(STEP08_REQUEST_START);
});

test("STEP 07 PR·CI box does not overflow horizontally at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openGuide(page);
  const box = sectionCode(panel, 7, "PR·CI 및 배포 확인");
  await expect(box).toBeVisible();
  const overflow = await box.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
