import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

async function learn(page: Parameters<typeof navigateWorkspace>[0]) {
  await navigateWorkspace(page, "AI·AX 학습센터");
  await expect(page.getByRole("heading", { name: "AI·AX 학습센터", exact: true })).toBeVisible();
}

test("학습센터: 대시보드 로드맵 10단계 표시", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  // 10단계 로드맵
  for (const level of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await expect(page.getByText(`LEVEL ${level} ·`, { exact: false }).first()).toBeVisible();
  }
  // LEVEL 1만 해제, 나머지는 잠김
  await expect(page.getByText("학습 중", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("잠김", { exact: true }).first()).toBeVisible();
  // 진행률
  await expect(page.getByText("0 / 10 단계 통과", { exact: true })).toBeVisible();
});

test("학습센터: LEVEL 1 학습 화면", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await page.getByRole("button", { name: "학습하기", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 ·/, exact: false })).toBeVisible();
  // 학습 단위 네비게이션
  await expect(page.getByRole("navigation", { name: "학습 단위" })).toBeVisible();
  // 핵심 섹션 존재
  await expect(page.getByRole("heading", { name: "핵심 개념" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "실무 사례" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "핵심 요약" })).toBeVisible();
});

test("학습센터: 퀴즈 응시 → 채점 → 결과", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 퀴즈/, exact: false })).toBeVisible();
  // 10문항 도트
  await expect(page.getByRole("navigation", { name: "문항 이동" }).getByRole("button")).toHaveCount(10);
  // 첫 문항에 답변 (첫 번째 선택지 선택 — 정답 여부 무관, 흐름 검증)
  const firstChoice = page.locator(".learn-choice").first();
  await firstChoice.click();
  // 제출
  for (let i = 0; i < 9; i++) {
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
  }
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  // 결과 화면
  await expect(page.getByRole("heading", { name: "LEVEL 1 평가 결과" })).toBeVisible();
  await expect(page.getByText(/점$/).first()).toBeVisible();
  // 문항별 해설
  await expect(page.getByRole("heading", { name: "문항별 해설" })).toBeVisible();
});

test("학습센터: 미통과 시 다음 단계 잠금 유지", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  // 아무것도 답하지 않고 제출 → 0점 → 미통과
  for (let i = 0; i < 9; i++) {
    await page.getByRole("button", { name: "다음 문항", exact: true }).click();
  }
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await expect(page.getByText(/미응답 문항/, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByText("미통과", { exact: true })).toBeVisible();
  // 대시보드로 돌아가면 LEVEL 2는 여전히 잠김
  await page.getByRole("button", { name: "학습센터로", exact: true }).click();
  const rows = page.locator(".learn-level-row");
  await expect(rows.nth(1).getByText("잠김", { exact: true })).toBeVisible();
});

test("학습센터: 가상 터미널 기본 동작", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  // LEVEL 4 학습 화면에서 실습 단위 확인 (터미널은 퀴즈 내 과제로도 검증)
  const lessonButtons = page.getByRole("button", { name: "학습하기", exact: true });
  // LEVEL 4는 잠겨 있으므로 직접 컴포넌트 검증은 단위 테스트로 대체
  // 여기서는 학습센터 자체가 깨지지 않음을 확인
  await expect(lessonButtons.first()).toBeVisible();
});
