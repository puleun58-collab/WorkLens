import { expect, test, type Page, type Route } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";

async function mockAssistant(page: Page) {
  await page.route("**/api/assistant", async (route: Route) => {
    const body = route.request().postDataJSON() as { question?: string };
    const question = body?.question ?? "";
    if (question.includes("오류")) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "PROVIDER_UNAVAILABLE" } }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          answer: `모의 답변: ${question.slice(0, 40)}`,
          sources: [{ screen: "업무 자동화 진단 > Level 기준", title: "자동화 Level 결정" }],
          kind: "answer",
        },
      }),
    });
  });
}

async function openAssistant(page: Page) {
  await page.goto("/");
  await mockAssistant(page);
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByRole("button", { name: "AI 도우미 열기" }).click();
  await expect(page.getByRole("dialog", { name: "렌즈봇" })).toBeVisible();
}

test("assistant: panel opens with reference layout elements", async ({ page }) => {
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  // Header: mascot + title + subtitle
  await expect(panel.locator(".wl-assistant-titles strong")).toHaveText("렌즈봇");
  // 3 control buttons only: reset, expand, close (no minimize)
  await expect(panel.getByRole("button", { name: "대화 초기화" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "패널 확장" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "AI 도우미 닫기" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "AI 도우미 최소화" })).toHaveCount(0);
  // No screen context checkbox
  await expect(panel.getByText("현재 화면 기준")).toHaveCount(0);
  // No "예시 질문" label (removed in reference UI), buttons have aria-label container
  await expect(panel.locator(".wl-assistant-examples")).toHaveAttribute("aria-label", "예시 질문");
  await expect(panel.getByRole("button", { name: "자동화 Level은 어떻게 결정되나요?" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "진행 보류와 확인 후 진행의 차이는?" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "올인원 지시문은 어떻게 사용하나요?" })).toBeVisible();
  // Footnote removed in reference UI
  await expect(panel.getByText("WorkLens 기능과 정책에 대한 안내만 제공합니다.")).toHaveCount(0);
  // Mascot images present
  await expect(panel.locator("img.wl-assistant-mascot").first()).toBeVisible();
});

test("assistant: example question sends and shows answer with sources", async ({ page }) => {
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  await panel.getByRole("button", { name: "자동화 Level은 어떻게 결정되나요?" }).click();
  await expect(panel.getByText("모의 답변: 자동화 Level은 어떻게 결정되나요?")).toBeVisible();
  await expect(panel.getByText("참고 근거")).toBeVisible();
  await expect(panel.getByText("업무 자동화 진단 > Level 기준 > 자동화 Level 결정")).toBeVisible();
});

test("assistant: Enter sends, Shift+Enter does not", async ({ page }) => {
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  const input = panel.getByLabel("질문 입력");
  await input.fill("Level 설명해줘");
  await input.press("Shift+Enter");
  await expect(panel.getByText("모의 답변: Level 설명해줘")).toHaveCount(0);
  await input.press("Enter");
  await expect(panel.getByText("모의 답변: Level 설명해줘")).toBeVisible();
});

test("assistant: minimize/expand/close and Escape", async ({ page }) => {
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  await panel.getByRole("button", { name: "패널 확장" }).click();
  await expect(panel).toHaveAttribute("data-expanded", "true");
  await panel.getByRole("button", { name: "패널 복원" }).click();
  await expect(panel).not.toHaveAttribute("data-expanded");
  await panel.getByRole("button", { name: "AI 도우미 닫기" }).click();
  await expect(panel).toHaveCount(0);
  const fab = page.getByRole("button", { name: "AI 도우미 열기" });
  await expect(fab).toBeVisible();
  await fab.click();
  await expect(page.getByRole("dialog", { name: "렌즈봇" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "렌즈봇" })).toHaveCount(0);
  await expect(fab).toBeFocused();
});

test("assistant: error shows retry and conversation is cleared on demand", async ({ page }) => {
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  const input = panel.getByLabel("질문 입력");
  await input.fill("오류를 발생시켜줘");
  await input.press("Enter");
  await expect(panel.getByText("지금은 응답할 수 없습니다.")).toBeVisible();
  const retry = panel.getByRole("button", { name: "다시 시도" });
  await expect(retry).toBeVisible();
  await input.fill("정상 질문");
  await input.press("Enter");
  await retry.click();
  await expect(panel.getByText("모의 답변: 정상 질문")).toBeVisible();
  await panel.getByRole("button", { name: "대화 초기화" }).click();
  // Reset restores the greeting message (reference UI)
  await expect(panel.getByText("안녕하세요!")).toBeVisible();
});

test("assistant: does not disturb body layout or scroll", async ({ page }) => {
  await page.goto("/");
  await mockAssistant(page);
  await navigateWorkspace(page, "업무 자동화 진단");
  const before = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollY: window.scrollY,
  }));
  await page.getByRole("button", { name: "AI 도우미 열기" }).click();
  await expect(page.getByRole("dialog", { name: "렌즈봇" })).toBeVisible();
  const after = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollY: window.scrollY,
  }));
  expect(after.width).toBe(before.width);
  expect(after.width).toBeLessThanOrEqual(after.clientWidth);
  expect(after.scrollY).toBe(before.scrollY);
});

test("assistant: sends question without task context by default", async ({ page }) => {
  let lastBody: { question?: string; context?: Record<string, unknown> } | null = null;
  await page.goto("/");
  await page.route("**/api/assistant", async (route: Route) => {
    lastBody = route.request().postDataJSON() as { question?: string; context?: Record<string, unknown> };
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ data: { answer: "ok", sources: [], relatedScreens: [], kind: "answer" } }),
    });
  });
  const task = taskFixture("task-ctx", diagnosisFixture);
  const state = { ...emptyAxState(), tasks: [task], step: 4, selectedTaskId: task.id };
  await page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, state);
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByRole("button", { name: "AI 도우미 열기" }).click();
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  // No context checkbox: questions send without task data by default.
  await panel.getByRole("button", { name: "자동화 Level은 어떻게 결정되나요?" }).click();
  await expect(panel.getByText("ok")).toBeVisible();
  expect(lastBody).not.toBeNull();
  expect(lastBody!.context).toBeUndefined();
});

test("assistant: related screens shown separately from evidence", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/assistant", async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        data: {
          answer: "법령 리서치는 종합 리서치에서 이용할 수 있습니다.",
          sources: [],
          relatedScreens: [{ screen: "종합 리서치 > 법령 리서치", title: "법령 리서치 위치" }],
          kind: "answer",
        },
      }),
    });
  });
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByRole("button", { name: "AI 도우미 열기" }).click();
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  const input = panel.getByLabel("질문 입력");
  await input.fill("법령 리서치 메뉴는 어디인가요?");
  await input.press("Enter");
  await expect(panel.getByText("관련 화면")).toBeVisible();
  await expect(panel.getByText("종합 리서치 > 법령 리서치 > 법령 리서치 위치")).toBeVisible();
  // No "참고 근거" for menu-only answers
  await expect(panel.getByText("참고 근거")).toHaveCount(0);
});

test("assistant: mobile layout fits 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAssistant(page);
  const panel = page.getByRole("dialog", { name: "렌즈봇" });
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "AI 도우미 열기" })).toHaveCount(0);
  await panel.getByRole("button", { name: "AI 도우미 닫기" }).click();
  await expect(page.getByRole("button", { name: "AI 도우미 열기" })).toBeVisible();
});
