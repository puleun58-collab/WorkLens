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
  const task: AxTask = { ...taskFixture("guide-a", diagnosis), name: "가이드 간격 확인 업무" };
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

/** Visible vertical gap between two elements, in whole CSS pixels.
 *
 * Read both boxes in a single evaluate call: the guide panel opens with a
 * 200ms height transition, and two separate boundingBox() round-trips can
 * straddle a layout shift, reporting a phantom gap (CI showed 75-216px for
 * a settled 16px gap). One synchronous read keeps the pair consistent.
 */
async function gap(upper: Locator, lower: Locator) {
  const lowerHandle = await lower.elementHandle();
  expect(lowerHandle).not.toBeNull();
  return upper.evaluate((upperEl, lowerEl) => {
    const upperRect = upperEl.getBoundingClientRect();
    const lowerRect = lowerEl.getBoundingClientRect();
    return Math.round(lowerRect.y - (upperRect.y + upperRect.height));
  }, lowerHandle);
}

/** Assert a gap once the layout has settled (e.g. after the panel transition). */
async function expectGap(upper: Locator, lower: Locator, expected: number) {
  await expect.poll(() => gap(upper, lower)).toBe(expected);
}

async function primaryColors(page: Page) {
  return page.evaluate(() => {
    const probe = (prop: "background" | "color", variable: string) => {
      const el = document.createElement("span");
      el.style[prop] = `var(${variable})`;
      document.body.append(el);
      const value = getComputedStyle(el)[prop === "background" ? "backgroundColor" : "color"];
      el.remove();
      return value;
    };
    return { bg: probe("background", "--primary"), fg: probe("color", "--primary-foreground") };
  });
}

test("C section gaps and STEP 03 move button follow the spacing spec", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await openGuide(page);
  const tutorial = panel.locator(".ax-setup-tutorial");
  await expect(tutorial).toBeVisible();

  // C. 다른 PC에서 작업 이어가기
  const sectionC = tutorial.locator(".ax-guide-section--cautions");
  await expect(sectionC.locator("h5")).toHaveText("C. 다른 PC에서 작업 이어가기");
  const codeWrap = sectionC.locator(".ax-guide-code-wrap");
  const stepsList = sectionC.locator("ol.ax-guide-list");
  const items = stepsList.locator("li");
  await expect(items).toHaveCount(4);
  const paragraphs = sectionC.locator(":scope > p");
  // h5 is not a p; direct p children are: when, intro text, caution 1, caution 2.
  const caution1 = paragraphs.nth(2);
  const caution2 = paragraphs.nth(3);
  await expect(caution1).toContainText("다른 PC의 작업이 GitHub에 푸시되어 있어야 합니다.");
  await expect(caution2).toContainText("로컬 변경사항이 있을 때는 무조건 브랜치를 전환하거나 가져오지 말고");
  await expectGap(codeWrap, stepsList, 16);
  for (let i = 0; i < 3; i++) await expectGap(items.nth(i), items.nth(i + 1), 8);
  await expectGap(stepsList, caution1, 20);
  await expectGap(caution1, caution2, 12);
  const nextSection = tutorial.locator(".ax-guide-section--cautions + .ax-guide-section");
  await expect(nextSection.locator("h5")).toHaveText("D. 새 프로젝트");
  await expectGap(caution2, nextSection, 28);

  // STEP 03 move button
  const step3 = tutorial.locator('.ax-guide-step[data-setup-step="3"]');
  const cta = step3.locator(".ax-guide-step-cta");
  await expect(cta).toHaveText("04 올인원 지시문으로 이동");
  const lastGuidance = step3.locator(".ax-guide-section > p").last();
  await expectGap(lastGuidance, cta, 14);
  const step4 = tutorial.locator('.ax-guide-step[data-setup-step="4"]');
  await expectGap(cta, step4, 22);
  const { bg, fg } = await primaryColors(page);
  const ctaStyle = await cta.evaluate(element => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color };
  });
  expect(ctaStyle.backgroundColor).toBe(bg);
  expect(ctaStyle.color).toBe(fg);
  // Only this button inside the tutorial uses the primary fill.
  const primaryButtons = await tutorial.locator("button").evaluateAll((buttons, primary) =>
    buttons.filter(button => getComputedStyle(button).backgroundColor === primary).map(button => button.textContent?.trim() ?? ""),
  bg);
  expect(primaryButtons).toEqual(["04 올인원 지시문으로 이동"]);
  // Hover darkens, focus shows the system ring, click moves to the instructions.
  await cta.hover();
  const hoverBg = await cta.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(hoverBg).not.toBe(ctaStyle.backgroundColor);
  await cta.focus();
  const focusShadow = await cta.evaluate(element => getComputedStyle(element).boxShadow);
  expect(focusShadow).not.toBe("none");
  await cta.click();
  const instructionsHeading = page.locator(".ax-plan-instructions h4");
  await expect(instructionsHeading).toBeFocused();
});

test("spacing holds on a narrow viewport without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openGuide(page);
  const tutorial = panel.locator(".ax-setup-tutorial");
  const sectionC = tutorial.locator(".ax-guide-section--cautions");
  const codeWrap = sectionC.locator(".ax-guide-code-wrap");
  const stepsList = sectionC.locator("ol.ax-guide-list");
  await expectGap(codeWrap, stepsList, 16);
  const step3 = tutorial.locator('.ax-guide-step[data-setup-step="3"]');
  const cta = step3.locator(".ax-guide-step-cta");
  const lastGuidance = step3.locator(".ax-guide-section > p").last();
  await expectGap(lastGuidance, cta, 14);
  const overflow = await cta.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
  expect(overflow).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
