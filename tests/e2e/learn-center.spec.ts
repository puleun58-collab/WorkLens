import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";

async function learn(page: Parameters<typeof navigateWorkspace>[0]) {
  await navigateWorkspace(page, "학습센터");
  await expect(page.getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
}

/** LEVEL 1 첫 번째 로드맵 행에서 학습 화면 진입 (현재 단계 행의 "이어서 학습" 버튼) */
async function openFirstLesson(page: Parameters<typeof navigateWorkspace>[0]) {
  await page.locator(".learn-dash-row").first().getByRole("button", { name: "이어서 학습", exact: true }).click();
}

/** 현재 문항에 답변 — 객관식/복수선택/사례판단은 첫 선택지, OX는 O 선택 */
async function answerCurrent(page: Parameters<typeof navigateWorkspace>[0]) {
  const choice = page.locator(".learn-choice").first();
  if ((await choice.count()) > 0) {
    await choice.click();
    return;
  }
  const ox = page.locator(".learn-ox").first();
  if ((await ox.count()) > 0) {
    await ox.click();
  }
}

test("학습센터: 대시보드 로드맵 10단계 표시", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  // 10단계 로드맵
  const rows = page.locator(".learn-dash-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.first().getByText("AI·AX 기초", { exact: true })).toBeVisible();
  // LEVEL 1만 해제, 나머지는 잠김
  await expect(page.getByText("학습 중", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("잠김", { exact: true }).first()).toBeVisible();
  // 진행률
  await expect(page.getByText(/0 \/ 10 단계 \(0%\)/, { exact: false })).toBeVisible();
});

test("학습센터: LEVEL 1 학습 화면", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await openFirstLesson(page);
  await expect(page.getByRole("heading", { name: /LEVEL 1 ·/, exact: false })).toBeVisible();
  // 학습센터로 돌아가기
  await expect(page.getByRole("button", { name: "학습센터로 돌아가기", exact: true })).toBeVisible();
  // 학습 단위 네비게이션
  await expect(page.getByRole("navigation", { name: "학습 단위" })).toBeVisible();
  // 진행률 표시 (숫자 위치만, "단원" 문구 없음)
  await expect(page.getByText("1 / 5", { exact: true })).toBeVisible();
  await expect(page.getByText(/전체 \d+단원/)).toHaveCount(0);
  // 핵심 섹션 존재
  await expect(page.getByRole("heading", { name: "핵심 개념" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "실무 사례" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "핵심 요약" })).toBeVisible();
  // 이동 버튼 문구 통일
  const nav = page.locator(".learn-quiz-nav");
  await expect(nav.getByRole("button", { name: "이전", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeVisible();
});

test("학습센터: 학습 단위 이동 — 이전·다음·직접 선택", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await openFirstLesson(page);
  const nav = page.locator(".learn-quiz-nav");
  // 다음 단위 이동
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^2\. /, exact: false })).toBeVisible();
  await expect(page.getByText("2 / 5", { exact: true })).toBeVisible();
  // 이전 단위 이동
  await nav.getByRole("button", { name: "이전", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^1\. /, exact: false })).toBeVisible();
  // 상단 단위 직접 선택
  await page.getByRole("navigation", { name: "학습 단위" }).getByRole("button", { name: /^3\. / }).click();
  await expect(page.getByRole("heading", { name: /^3\. /, exact: false })).toBeVisible();
  await expect(page.getByText("3 / 5", { exact: true })).toBeVisible();
  // 저장 오류 배너가 없어야 함
  await expect(page.locator(".learn-save-error")).toHaveCount(0);
});

test("학습센터: 빠른 연속 이동 시 저장 충돌 오판 없음", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await openFirstLesson(page);
  const nav = page.locator(".learn-quiz-nav");
  // 빠르게 3회 연속 이동 (저장 직렬화 구간)
  for (let i = 0; i < 3; i++) {
    await nav.getByRole("button", { name: "다음", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: /^4\. /, exact: false })).toBeVisible();
  // "다른 탭" 오판 배너가 없어야 함
  await expect(page.locator(".learn-save-error")).toHaveCount(0);
  // 새로고침 후에도 4단원 복원 (학습센터로 다시 진입)
  await page.reload();
  await learn(page);
  await openFirstLesson(page);
  await expect(page.getByRole("heading", { name: /^4\. /, exact: false })).toBeVisible();
  await expect(page.locator(".learn-save-error")).toHaveCount(0);
});

test("학습센터: 실제 다른 탭 변경 시 충돌 보호 동작", async ({ page, context }) => {
  await page.goto("/");
  await learn(page);
  await openFirstLesson(page);
  await expect(page.getByRole("heading", { name: /^1\. /, exact: false })).toBeVisible();

  // 같은 브라우저 컨텍스트의 다른 탭에서 진도 변경 (IndexedDB 공유)
  const page2 = await context.newPage();
  await page2.goto("/");
  await learn(page2);
  await openFirstLesson(page2);
  await page2.locator(".learn-quiz-nav").getByRole("button", { name: "다음", exact: true }).click();
  // 다른 탭의 저장이 IndexedDB에 반영될 때까지 대기
  await page2.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-learn", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const value: { levels?: Record<string, { lastStudiedUnitId?: string }> } | undefined =
        await new Promise((resolve) => {
          const tx = db.transaction("progress", "readonly");
          const q = tx.objectStore("progress").get("current");
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => resolve(undefined);
        });
      return value?.levels?.["1"]?.lastStudiedUnitId === "l1-u2";
    } finally {
      db.close();
    }
  });
  await page2.close();

  // 원래 탭에서 이동 시도 → 실제 충돌 감지 → 배너 표시 + 최신 데이터(2단원)로 복원
  await page.locator(".learn-quiz-nav").getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator(".learn-save-error")).toBeVisible();
  await expect(page.locator(".learn-save-error")).toContainText("다른 탭");
  await expect(page.getByRole("heading", { name: /^2\. /, exact: false })).toBeVisible();
  // 학습 화면은 유지되어야 함 (빈 화면 금지)
  await expect(page.getByRole("heading", { name: "핵심 개념" })).toBeVisible();
});

test("학습센터: 오답 노트 빈 상태", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await page.getByRole("button", { name: /오답 노트/, exact: false }).click();
  await expect(page.getByRole("heading", { name: "오답 노트", exact: true })).toBeVisible();
  // 빈 상태: 아이콘 + 안내 + 학습센터로 이동 버튼 하나만 강조
  await expect(page.getByText("아직 복습할 오답이 없습니다", { exact: true })).toBeVisible();
  await expect(page.getByText(/틀린 문제가 있으면 이곳에 표시됩니다/, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "학습센터로 이동", exact: true }).click();
  await expect(page.locator(".learn-view").getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
});

test("학습센터: 사전 진단 — 중복 건너뛰기 제거·복귀 동선", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await page.getByRole("button", { name: "사전 진단 받기 (선택)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "사전 진단 (선택)", exact: true })).toBeVisible();
  // 문제 화면 하단의 중복 건너뛰기 버튼 제거됨
  await expect(page.getByRole("button", { name: "건너뛰기", exact: true })).toHaveCount(0);
  // 학습센터로 돌아가기 동선 유지
  await expect(page.getByRole("button", { name: "학습센터로 돌아가기", exact: true })).toBeVisible();
  // 이전·다음 문항 이동 유지
  const nav = page.locator(".learn-quiz-nav");
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator(".learn-question-meta")).toContainText("2 / 8");
  await nav.getByRole("button", { name: "이전", exact: true }).click();
  await expect(page.locator(".learn-question-meta")).toContainText("1 / 8");
  // 돌아가기
  await page.getByRole("button", { name: "학습센터로 돌아가기", exact: true }).click();
  await expect(page.locator(".learn-view").getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
});

test("학습센터: 퀴즈 응시 → 채점 → 결과", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 퀴즈/, exact: false })).toBeVisible();
  // 10문항 도트
  await expect(page.getByRole("navigation", { name: "문항 이동" }).getByRole("button")).toHaveCount(10);
  // 각 문항에 답변 (정답 여부 무관, 흐름 검증)
  for (let i = 0; i < 10; i++) {
    await answerCurrent(page);
    if (i < 9) {
      await page.getByRole("button", { name: "다음", exact: true }).click();
    }
  }
  // 제출
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
    await page.getByRole("button", { name: "다음", exact: true }).click();
  }
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await expect(page.getByText(/미응답 문항/, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByText(/미통과/, { exact: false })).toBeVisible();
  // 대시보드로 돌아가면 LEVEL 2는 여전히 잠김
  await page.getByRole("button", { name: "학습센터로", exact: true }).click();
  const rows = page.locator(".learn-dash-row");
  await expect(rows.nth(1).getByText("잠김", { exact: true })).toBeVisible();
});

test("학습센터: 가상 터미널 기본 동작", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  // LEVEL 4는 잠겨 있으므로 직접 컴포넌트 검증은 단위 테스트로 대체
  // 여기서는 학습센터 자체가 깨지지 않음을 확인 — 잠긴 행에는 실행 버튼이 없어야 한다
  const rows = page.locator(".learn-dash-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.nth(3).getByRole("button")).toHaveCount(0);
});

test("학습센터: 신규 사용자에게 처음 학습하기 표시", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  // 응시 이력이 없으면 "처음 학습하기"
  await expect(page.getByRole("button", { name: /처음 학습하기/, exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /이어서 학습하기/, exact: false })).toHaveCount(0);
});

test("학습센터: 메뉴 순서 — 학습센터가 업무 자동화 진단 바로 위", async ({ page }) => {
  await page.goto("/");
  // AI•AX 그룹 내 메뉴 순서 확인
  const nav = page.locator("nav").first();
  const items = await nav.getByRole("button").allTextContents();
  const learnIdx = items.findIndex((t) => t.trim() === "학습센터");
  const axIdx = items.findIndex((t) => t.includes("업무 자동화 진단"));
  expect(learnIdx).toBeGreaterThanOrEqual(0);
  expect(axIdx).toBeGreaterThanOrEqual(0);
  expect(axIdx).toBe(learnIdx + 1);
});
