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
const STEP08_REQUEST_START = "완성한 프로그램을 실제 사용 상황처럼 테스트해 줘.";

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
