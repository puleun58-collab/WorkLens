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

async function openFlow(page: Page) {
  const diagnosis = { ...diagnosisFixture, planCodex: planFixture };
  const task: AxTask = { ...taskFixture("flow-align", diagnosis), name: "Git 흐름 정렬 확인 업무" };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const plan = page.getByRole("region", { name: "자동화 구현 계획", exact: true });
  await expect(plan).toBeVisible();
  const guideTrigger = plan.getByRole("button", { name: "설치·시작 가이드", exact: true });
  await guideTrigger.click();
  await expect(guideTrigger).toHaveAttribute("aria-expanded", "true");
  const panel = plan.locator(".ax-guide-panel");
  const terms = panel.locator(".ax-tutorial-glossary");
  const trigger = terms.getByRole("button");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Instant pre-scroll (same smooth-scroll race guard as ax.spec.ts expectGuideTutorial).
  await trigger.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "nearest" }));
  await trigger.focus();
  await page.keyboard.press("Enter");
  const flow = terms.locator(".ax-git-flow");
  await expect(flow).toBeVisible();
  return { terms, flow, trigger };
}

/** Read all card/group boxes in one synchronous pass so a mid-animation layout shift cannot skew the pair. */
async function measure(flow: Locator) {
  return flow.evaluate(flowEl => {
    const rect = (el: Element) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right };
    };
    const cards = [...flowEl.querySelectorAll(".ax-git-flow-card")].map(rect);
    const groups = [...flowEl.querySelectorAll(".ax-git-flow-group")].map(rect);
    return { cards, groups };
  });
}

test("Git flow header logo appears once and bottom boxes align 2:1 with top cards (desktop)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { terms, flow } = await openFlow(page);

  // ① Logo: trigger only. The panel header must not carry a second GitHub logo.
  await expect(terms.locator('img[src="/brand/github-mark.svg"]')).toHaveCount(1);
  await expect(flow.locator('img[src="/brand/github-mark.svg"]')).toHaveCount(0);
  await expect(flow.locator(".ax-git-flow-head p")).toHaveText("코드 변경부터 배포까지의 전체 과정을 순서대로 확인하세요.");

  // ② 2:1 alignment: each group box must start where its first card starts and end where its second card ends.
  await expect.poll(async () => {
    const { cards, groups } = await measure(flow);
    if (cards.length !== 10 || groups.length !== 5) return -1;
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      worst = Math.max(worst, Math.abs(groups[i].left - cards[2 * i].left), Math.abs(groups[i].right - cards[2 * i + 1].right));
    }
    return worst;
  }).toBeLessThanOrEqual(1);

  // No page-level horizontal overflow on desktop.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Git flow keeps order and no page overflow on mobile 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { terms, flow, trigger } = await openFlow(page);

  await expect(terms.locator('img[src="/brand/github-mark.svg"]')).toHaveCount(1);
  await expect(flow.locator('img[src="/brand/github-mark.svg"]')).toHaveCount(0);
  await expect(flow.locator(".ax-git-flow-head p")).toHaveText("코드 변경부터 배포까지의 전체 과정을 순서대로 확인하세요.");

  // Order and 2:1 correspondence survive the stacked layout: cards 01..10, groups 01~02..09~10.
  const cardNos = await flow.locator(".ax-git-flow-no").allTextContents();
  expect(cardNos).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
  const groupTitles = await flow.locator(".ax-git-flow-group-head h6").allTextContents();
  expect(groupTitles).toEqual([
    "01~02 저장소 준비·브랜치",
    "03~04 변경 추가·커밋",
    "05~06 업로드·PR",
    "07~08 CI·Merge",
    "09~10 배포·검증",
  ]);

  // The track alone may scroll sideways; the page itself must not.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Expand/collapse still works.
  await trigger.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "nearest" }));
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(flow).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(flow).toBeVisible();
});
