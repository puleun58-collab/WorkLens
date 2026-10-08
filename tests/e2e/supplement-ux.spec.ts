import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { createPptxSlides } from "../fixtures";
import { navigateWorkspace } from "./navigation";

const fixtureDir = path.join(process.cwd(), "artifacts", "fixtures");
const costDeck = path.join(fixtureDir, "보완_UX_비용.pptx");
const clearDeck = path.join(fixtureDir, "보완_UX_안내.pptx");
const baselineDeck = path.join(fixtureDir, "보완_UX_실적.pptx");
const manyDeck = path.join(fixtureDir, "보완_UX_다수항목.pptx");
const issueDeck = path.join(fixtureDir, "보완_UX_납기.pptx");

test.beforeAll(async () => {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(costDeck, createPptxSlides([
    ["2026년 9월 비용 보고", "운영 현황"],
    ["비용 현황", "물류비가 전월 대비 18% 증가했습니다."],
  ]));
  await writeFile(clearDeck, createPptxSlides([
    ["교육 안내", "교육은 9월 28일 3층 대회의실에서 진행됩니다.", "참석 대상은 현장 관리자입니다.", "필기도구를 준비해 주세요."],
  ]));
  await writeFile(baselineDeck, createPptxSlides([
    ["2026년 9월 실적 보고", "실적 현황"],
    ["고객 만족도 현황", "고객 만족도 82점"],
  ]));
  await writeFile(issueDeck, createPptxSlides([
    ["9월 이슈 보고", "주요 이슈를 공유합니다."],
    ["납기 이슈", "고객사 A 납기 지연 12건 발생"],
    ["기타", "10월 생산 계획은 전월과 동일합니다."],
  ]));
  await writeFile(manyDeck, createPptxSlides([
    ["2026년 9월 실적 보고", "센터별 실적 현황"],
    ...Array.from({ length: 12 }, (_, index) => [
      `센터 ${index + 1} 실적`,
      `서울동부생활물류고객지원운영센터${index + 1} 만족도 ${82 + index}점`,
    ]),
  ]));
});

async function prepare(page: Page, deck = costDeck) {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(deck);
  await expect(page.locator(".file-row").filter({ hasText: path.basename(deck) })).toBeVisible();
  await page.getByRole("checkbox", { name: `${path.basename(deck)} 선택`, exact: true }).check();
  await navigateWorkspace(page, "보완");
}

function completeReview(route: Route) {
  const { checks } = route.request().postDataJSON() as { checks: Array<{ id: string }> };
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: { kind: "supplement-review", verdicts: checks.map(({ id }) => ({ id, verdict: "not_found", handles: [] })) } }),
  });
}

for (const width of [1440, 390]) {
  test(`보완은 ${width}px에서 부족한 내용·확인할 정보·접힌 원문과 바로 보이는 근거를 구분한다`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route("**/api/ai", completeReview);
    await prepare(page);
    await page.getByRole("button", { name: "보완 실행", exact: true }).click();
    const results = page.locator(".supplement-results");
    const cause = results.locator(".supplement-item").filter({ has: page.getByRole("heading", { name: "증가 원인 미확인", exact: true }) });
    await expect(cause).toBeVisible();
    await expect(cause.locator(".check-severity")).toHaveText("중요");
    const fields = cause.locator(".supplement-fields").first();
    await expect(cause.getByRole("button", { name: /근거 보기/ })).toBeVisible();
    await expect(fields.locator("dt")).toHaveText(["확인할 정보", "확인 이유", "근거"]);
    await expect(fields.locator(".supplement-message")).toHaveText("물류비가 전월 대비 18% 증가했다고 제시되어 있지만 현재 자료에서 주요 증가 원인 설명을 확인하지 못했습니다.");
    await expect(fields).not.toContainText("보고받는 사람이 먼저 원인을 물을 가능성");
    const original = cause.locator("details.supplement-original");
    await expect(original).not.toHaveAttribute("open", "");
    await expect(original.getByText("현재 자료", { exact: true })).toBeHidden();
    await expect(original.getByText("2P", { exact: true })).toBeHidden();
    await original.getByText("현재 자료 및 원문 위치 보기").click();
    await expect(original.locator("q")).toHaveText("물류비가 전월 대비 18% 증가했습니다.");
    await expect(original.locator(".supplement-location")).toHaveText("2P");
    const additions = cause.locator("ul.supplement-readable-list > li > span:last-child");
    await expect(additions).toHaveText(["주요 증가 요인", "요인별 영향 규모", "일회성 여부"]);
    await expect(results.getByRole("heading", { name: "보고 전 확인할 질문", exact: true })).toBeVisible();
    const questions = results.locator(".supplement-questions li > span:last-child");
    for (const question of await questions.allTextContents()) {
      await expect(results.locator(".supplement-fields dd").getByText(question, { exact: true })).toHaveCount(0);
    }
    const geometry = await results.evaluate((root) => {
      const heading = root.querySelector(".supplement-questions h3")!;
      const marker = root.querySelector(".supplement-questions .supplement-list-marker")!;
      const text = marker.nextElementSibling!;
      const ul = root.querySelector(".supplement-fields ul")!;
      return {
        headingLeft: heading.getBoundingClientRect().left,
        markerLeft: marker.getBoundingClientRect().left,
        gap: text.getBoundingClientRect().left - marker.getBoundingClientRect().right,
        additionsPadding: getComputedStyle(ul).paddingLeft,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(Math.abs(geometry.headingLeft - geometry.markerLeft)).toBeLessThanOrEqual(1);
    expect(geometry.gap).toBeGreaterThanOrEqual(8);
    expect(geometry.gap).toBeLessThanOrEqual(12);
    expect(geometry.additionsPadding).toBe("0px");
    expect(geometry.overflow).toBe(false);
    await results.screenshot({ path: `artifacts/supplement-ux-${width}.png` });
    const source = cause.getByRole("button", { name: /근거 보기/ }).first();
    await source.click();
    const detail = page.getByLabel("근거 상세", { exact: true });
    await expect(detail).toBeFocused();
    await expect(detail).toContainText("Slide 2");
    await expect(detail.locator("blockquote")).toContainText("물류비가 전월 대비 18% 증가했습니다.");
    await detail.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(source).toBeFocused();
  });
}

test("후속 대응의 추측성 이유는 반복하지 않고 영향의 판단 이유는 보여 준다", async ({ page }) => {
  await page.route("**/api/ai", completeReview);
  await prepare(page, issueDeck);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  const response = page.locator(".supplement-item").filter({ has: page.getByRole("heading", { name: "대응 내용 미확인", exact: true }) });
  await expect(response).toBeVisible();
  await expect(response.locator(".supplement-fields").first().locator("dt")).toHaveText(["확인할 정보", "확인 이유", "근거"]);
  await expect(response).not.toContainText("보고받는 사람은 후속 조치를 먼저 확인");
  const impact = page.locator(".supplement-item").filter({ has: page.getByRole("heading", { name: "영향 설명 미확인", exact: true }) });
  await expect(impact.locator(".supplement-fields").first().locator("dt").filter({ hasText: "확인 이유" })).toHaveCount(1);
  await expect(impact).toContainText("영향 범위를 알아야 우선순위와 대응 수준을 정할 수 있습니다.");
});

test("보완 실행 중에는 실행 버튼만 처리 상태를 보이고 연속 클릭으로 요청을 중복하지 않는다", async ({ page }) => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  await page.route("**/api/ai", async (route) => {
    calls += 1;
    await gate.promise;
    await completeReview(route);
  });
  await prepare(page);
  const run = page.getByRole("button", { name: "보완 실행", exact: true });
  await expect(run).toBeEnabled();
  await expect(run).toHaveText("실행");
  await run.click({ clickCount: 2 });
  await expect.poll(() => calls).toBe(1);
  await expect(run).toBeDisabled();
  await expect(run).toHaveText("처리 중…");
  await expect(page.locator(".processing-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "중지", exact: true })).toHaveCount(0);
  gate.resolve();
  await expect(page.locator(".supplement-results")).toBeVisible();
  await expect(run).toBeEnabled();
  await expect(run).toHaveText("실행");
  expect(calls).toBe(1);
});

test("보완 API 오류 뒤 결정적 결과와 한계를 보존하고 다시 실행할 수 있다", async ({ page }) => {
  let fail = true;
  let calls = 0;
  await page.route("**/api/ai", (route) => {
    calls += 1;
    return fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "AI_PROVIDER_REJECTED", message: "처리 실패" } }) }) : completeReview(route);
  });
  await prepare(page);
  const run = page.getByRole("button", { name: "보완 실행", exact: true });
  await run.click();
  await expect(page.getByText("일부 항목의 재확인을 완료하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.locator(".supplement-item").getByRole("heading", { name: /원인 미확인$/ })).toBeVisible();
  await expect(page.locator(".supplement-results")).toContainText("일부 항목은 의미 기반 재확인을 마치지 못했습니다.");
  await expect(run).toBeEnabled();
  fail = false;
  await run.click();
  await expect(page.locator(".supplement-results")).toBeVisible();
  await expect(page.locator(".supplement-results")).not.toContainText("의미 기반 재확인을 마치지 못했습니다.");
  await expect(page.getByText("일부 항목의 재확인을 완료하지 못했습니다.", { exact: true })).toHaveCount(0);
  expect(calls).toBe(2);
});

test("보완의 늦은 응답은 이동한 분석 화면에 보완 결과나 알림을 표시하지 않는다", async ({ page }) => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  await page.route("**/api/ai", async (route) => {
    calls += 1;
    await gate.promise;
    await completeReview(route);
  });
  await prepare(page);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await navigateWorkspace(page, "분석");
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeDisabled();
  gate.resolve();
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeEnabled();
  await expect(page.locator(".supplement-results")).toHaveCount(0);
  await expect(page.getByText("보완 항목을 확인했습니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "보완 결과", exact: true })).toHaveCount(0);
});

test("보완 35초 타임아웃은 세 번의 기존 시도 후 한계를 알리고 버튼을 복구한다", async ({ page }) => {
  let calls = 0;
  let aborted = 0;
  page.on("requestfailed", (request) => { if (request.url().endsWith("/api/ai")) aborted += 1; });
  await page.route("**/api/ai", () => { calls += 1; });
  await prepare(page);
  await page.clock.install();
  const run = page.getByRole("button", { name: "보완 실행", exact: true });
  await run.click();
  await expect.poll(() => calls).toBe(1);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.clock.fastForward(35_001);
    await expect.poll(() => aborted).toBe(attempt);
    if (attempt < 3) {
      await page.clock.runFor(500 * attempt + 1);
      await expect.poll(() => calls).toBe(attempt + 1);
    }
  }
  await expect(page.getByText("일부 항목의 재확인을 완료하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.locator(".supplement-results")).toContainText("일부 항목은 의미 기반 재확인을 마치지 못했습니다.");
  await expect(run).toBeEnabled();
  expect(calls).toBe(3);
  await page.unroute("**/api/ai");
  await page.route("**/api/ai", completeReview);
  await run.click();
  await expect(page.locator(".supplement-results")).not.toContainText("의미 기반 재확인을 마치지 못했습니다.");
  await expect(run).toBeEnabled();
});

test("보완 항목이 없는 안내 자료는 읽은 범위의 빈 결과를 알리고 빈 질문을 만들지 않는다", async ({ page }) => {
  await page.route("**/api/ai", completeReview);
  await prepare(page, clearDeck);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  await expect(page.locator(".supplement-clear")).toContainText("중요한 보완 항목을 확인하지 못했습니다.");
  await expect(page.locator(".supplement-clear")).toContainText("점검한 범위에서 추가할 항목을 찾지 못했습니다.");
  await expect(page.locator(".supplement-item")).toHaveCount(0);
  await expect(page.locator(".supplement-questions")).toHaveCount(0);
});

test("숫자는 있으나 목표·이전 기간이 없는 자료는 원문 값과 비교에 필요한 정보를 구분한다", async ({ page }) => {
  await page.route("**/api/ai", completeReview);
  await prepare(page, baselineDeck);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  const baseline = page.locator(".supplement-item").filter({ has: page.getByRole("heading", { name: "비교 기준 미확인", exact: true }) });
  await expect(baseline).toBeVisible();
  await expect(baseline.locator(".check-severity")).toHaveText("확인 필요");
  expect((await baseline.locator(".supplement-item-head").innerText()).match(/확인 필요/g)).toHaveLength(1);
  await expect(baseline.locator(".supplement-fields").first().locator("dt")).toHaveText(["확인할 정보", "확인 이유", "근거"]);
  await expect(baseline.locator("ul.supplement-readable-list > li > span:last-child")).toHaveText(["목표값 또는 기준값", "이전 기간 값"]);
  await expect(baseline.locator(".supplement-explanation").last()).toContainText("기준이 없으면 이 수치가 좋은지 나쁜지 판단하기 어렵습니다.");
  const original = baseline.locator("details.supplement-original");
  await expect(original).not.toHaveAttribute("open", "");
  await original.getByText("현재 자료 및 원문 위치 보기").click();
  await expect(original.locator("q")).toHaveText("고객 만족도 82점");
});

test("모바일의 많은 긴 질문은 줄바꿈되어도 번호와 본문이 겹치지 않고 개별 질문을 잃지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/ai", completeReview);
  await prepare(page, manyDeck);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  const results = page.locator(".supplement-results");
  await expect(results.locator(".supplement-item")).toHaveCount(12);
  const questions = results.locator(".supplement-questions li > span:last-child");
  const topQuestions = await questions.allTextContents();
  expect(topQuestions.length).toBeLessThan(12);
  const extraQuestions = results.locator(".supplement-fields > div").filter({ has: page.getByText("예상 질문", { exact: true }) }).locator("dd");
  const remaining = await extraQuestions.allTextContents();
  expect(new Set([...topQuestions, ...remaining]).size).toBe(12);
  expect(remaining.every((question) => !topQuestions.includes(question))).toBe(true);
  const layout = await questions.first().evaluate((body) => {
    const marker = body.previousElementSibling!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const lines = [...range.getClientRects()];
    return {
      lines: lines.length,
      hanging: lines.every((line) => Math.abs(line.left - lines[0].left) <= 1),
      gap: body.getBoundingClientRect().left - marker.getBoundingClientRect().right,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout.lines).toBeGreaterThan(1);
  expect(layout.hanging).toBe(true);
  expect(layout.gap).toBeGreaterThanOrEqual(8);
  expect(layout.gap).toBeLessThanOrEqual(12);
  expect(layout.overflow).toBe(false);
  const original = results.locator(".supplement-item details.supplement-original").first();
  await expect(original).not.toHaveAttribute("open", "");
  await original.getByText("현재 자료 및 원문 위치 보기").click();
  await expect(original.locator("q")).toContainText("서울동부생활물류고객지원운영센터");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("재확인이 근거 없이 설명을 찾았다고 답해도 기존 위치와 확인 제한을 잃지 않는다", async ({ page }) => {
  await page.route("**/api/ai", (route) => {
    const { checks } = route.request().postDataJSON() as { checks: Array<{ id: string }> };
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ data: { kind: "supplement-review", verdicts: checks.map(({ id }) => ({ id, verdict: "found", handles: [] })) } }),
    });
  });
  await prepare(page);
  await page.getByRole("button", { name: "보완 실행", exact: true }).click();
  const cause = page.locator(".supplement-item").filter({ has: page.getByRole("heading", { name: "증가 원인 미확인", exact: true }) });
  await expect(cause).toBeVisible();
  await expect(cause.locator(".supplement-limitation")).toContainText("AI가 제시한 근거에서 필요한 구체 정보를 확인하지 못해 누락 여부를 확정하지 않았습니다.");
  await expect(cause.locator(".check-severity")).toHaveText("확인 필요");
  await expect(cause.getByRole("heading", { name: "증가 원인 미확인" })).toBeVisible();
  const original = cause.locator("details.supplement-original");
  await expect(original).not.toHaveAttribute("open", "");
  await original.getByText("현재 자료 및 원문 위치 보기").click();
  await expect(original.locator("q")).toHaveText("물류비가 전월 대비 18% 증가했습니다.");
  await expect(original.locator(".supplement-location")).toContainText("2P");
  await cause.getByRole("button", { name: /근거 보기/ }).click();
  await expect(page.getByLabel("근거 상세", { exact: true }).locator("blockquote")).toContainText("물류비가 전월 대비 18% 증가했습니다.");
});
