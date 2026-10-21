import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { navigateWorkspace } from "./navigation";
import { DIAGNOSTIC_QUESTIONS } from "../../src/lib/learn/questions-diagnostic";
import { questionBank } from "../../src/lib/learn/questions";
import { questionFingerprint } from "../../src/lib/learn/scoring";
import {
  executeCommand,
  initialStateForScenario,
  serializeTerminalState,
} from "../../src/lib/learn/terminal";

async function learn(page: Parameters<typeof navigateWorkspace>[0]) {
  await navigateWorkspace(page, "학습센터");
  // 모바일 셸의 h1과 겹치지 않게 학습 뷰 내부 제목으로 범위 지정
  await expect(page.locator(".learn-view").getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
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
  // 전 단계 통과 기준 80점 통일 표시
  await expect(page.locator(".learn-dash-row", { hasText: "통과 80점" })).toHaveCount(10);
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
  // 퀴즈 화면에도 통과 기준 80점 표시
  await expect(page.getByText(/80점 이상 통과/, { exact: false })).toBeVisible();
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

test("학습센터: 오답 노트에서 관련 단위로 직접 이동", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  // 무응답 제출 → 전부 오답 → 오답 노트 생성
  for (let i = 0; i < 9; i++) {
    await page.getByRole("button", { name: "다음", exact: true }).click();
  }
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByText(/미통과 \(기준 80점\)/, { exact: false })).toBeVisible();
  // 결과 화면의 오답 문항에도 관련 학습 이동 버튼이 있어야 한다
  await expect(page.getByRole("button", { name: "관련 내용 학습하기", exact: true }).first()).toBeVisible();
  // 오답 노트로 이동
  await page.getByRole("button", { name: "오답 노트 보기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "오답 노트", exact: true })).toBeVisible();
  const firstNote = page.locator(".learn-note-item").first();
  const metaText = (await firstNote.locator(".learn-question-meta").textContent()) ?? "";
  const unitTitle = metaText.split("관련 학습:")[1]?.trim();
  expect(unitTitle, "오답에 연결된 학습 단위 제목이 표시되어야 한다").toBeTruthy();
  await firstNote.getByRole("button", { name: "관련 내용 학습하기", exact: true }).click();
  // 해당 단위가 선택된 학습 화면으로 이동 (단위 제목 heading 확인)
  await expect(page.locator(".learn-lesson-unit-title")).toContainText(unitTitle!);
});

/** IndexedDB의 진행 중 응시 기록을 읽는다 (없으면 null) */
async function readInProgressState(page: Parameters<typeof navigateWorkspace>[0]) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-learn", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const value: { answers?: Record<string, unknown>; currentIndex?: number } | undefined =
        await new Promise((resolve) => {
          const tx = db.transaction("progress", "readonly");
          const q = tx.objectStore("progress").get("in-progress");
          q.onsuccess = () => resolve(q.result);
          q.onerror = () => resolve(undefined);
        });
      if (!value) return null;
      return { answers: Object.keys(value.answers ?? {}).length, currentIndex: value.currentIndex ?? -1 };
    } finally {
      db.close();
    }
  });
}

/** 진행 중 응시 기록이 기대 상태로 저장될 때까지 대기 (Node 측 폴링) */
async function waitInProgressState(
  page: Parameters<typeof navigateWorkspace>[0],
  expected: { answers: number; currentIndex: number },
) {
  await expect
    .poll(() => readInProgressState(page), { timeout: 15_000 })
    .toEqual({ answers: expected.answers, currentIndex: expected.currentIndex });
}

test("학습센터: 퀴즈 진행 중 새로고침 후 응시 복구", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 퀴즈/, exact: false })).toBeVisible();
  // 답변 가능한(객관식·OX) 문항 2개에 답변 — 출제 구성은 응시마다 달라지므로 적응적으로 찾는다
  const answeredIdx: number[] = [];
  let firstPrompt: string | null = null;
  for (let i = 0; i < 10 && answeredIdx.length < 2; i++) {
    const answerable = (await page.locator(".learn-choice, .learn-ox").count()) > 0;
    if (answerable) {
      if (answeredIdx.length === 0) {
        firstPrompt = await page.locator(".learn-question-prompt").textContent();
      }
      await answerCurrent(page);
      answeredIdx.push(i);
    }
    if (answeredIdx.length < 2) {
      await page.getByRole("button", { name: "다음", exact: true }).click();
    }
  }
  expect(answeredIdx).toHaveLength(2);
  // 두 번째로 답변한 문항의 다음 위치에서 중단한 상태로 만든다
  await page.getByRole("button", { name: "다음", exact: true }).click();
  const resumeIndex = answeredIdx[1] + 1;
  await expect(page.locator(".learn-assess-progress-text")).toHaveText(`${resumeIndex + 1} / 10 문항`);
  // 진행 중 응시가 저장될 때까지 대기한 뒤 새로고침
  await waitInProgressState(page, { answers: 2, currentIndex: resumeIndex });
  await page.reload();
  await learn(page);
  // 대시보드에 진행 중 퀴즈 안내가 표시된다
  const resumeCard = page.locator('section[aria-label="진행 중인 퀴즈"]');
  await expect(resumeCard).toBeVisible();
  await expect(resumeCard).toContainText("LEVEL 1 · 답변 2 / 10");
  await resumeCard.getByRole("button", { name: "이어서 응시하기", exact: true }).click();
  // 문제 위치·답변이 복원된다 (다시 섞이지 않음)
  await expect(page.locator(".learn-assess-progress-text")).toHaveText(`${resumeIndex + 1} / 10 문항`);
  const dots = page.getByRole("navigation", { name: "문항 이동" }).getByRole("button");
  await expect(dots.nth(answeredIdx[0])).toHaveClass(/is-answered/);
  await expect(dots.nth(answeredIdx[1])).toHaveClass(/is-answered/);
  await expect(dots.nth(resumeIndex)).not.toHaveClass(/is-answered/);
  // 처음 답변한 문항으로 이동하면 문제와 선택한 답변이 그대로다
  await dots.nth(answeredIdx[0]).click();
  await expect(page.locator(".learn-question-prompt")).toHaveText(firstPrompt ?? "");
  await expect(page.locator(".learn-choice.is-selected, .learn-ox.is-selected")).toHaveCount(1);
  // 마지막 문항에서 제출 → 결과 화면 (복구된 응시가 정상 제출된다)
  await dots.nth(9).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LEVEL 1 평가 결과" })).toBeVisible();
  // 제출 후에는 진행 중 안내가 사라진다
  await page.getByRole("button", { name: "학습센터로", exact: true }).click();
  await expect(page.locator('section[aria-label="진행 중인 퀴즈"]')).toHaveCount(0);
});

test("학습센터: 제출 저장 실패 시 답변 유지 후 재시도 성공", async ({ page }) => {
  // 학습 진도 저장(put "current")만 실패시키는 주입 — 진행 중 응시 저장은 영향 없음
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const flag = (window as unknown as { __failLearnProgressSave?: boolean }).__failLearnProgressSave;
      if (flag && key === "current" && this.name === "progress") {
        throw new DOMException("injected save failure", "AbortError");
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 퀴즈/, exact: false })).toBeVisible();
  // 1번 문항에 답변하고 마지막 문항으로 이동
  await answerCurrent(page);
  const dots = page.getByRole("navigation", { name: "문항 이동" }).getByRole("button");
  await dots.nth(9).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  // 저장 실패 주입 후 제출
  await page.evaluate(() => {
    (window as unknown as { __failLearnProgressSave?: boolean }).__failLearnProgressSave = true;
  });
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  // 결과 화면으로 확정 표시되지 않고, 답변 유지 + 재시도 동선이 제공된다
  await expect(page.getByRole("button", { name: "다시 저장하기", exact: true })).toBeVisible();
  await expect(page.getByText(/채점 결과를 저장하지 못했습니다/, { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "LEVEL 1 평가 결과" })).toHaveCount(0);
  // 주입 해제 후 재시도 → 저장 확정 → 결과 화면
  await page.evaluate(() => {
    (window as unknown as { __failLearnProgressSave?: boolean }).__failLearnProgressSave = false;
  });
  await page.getByRole("button", { name: "다시 저장하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LEVEL 1 평가 결과" })).toBeVisible();
  // 새로고침해도 응시 기록이 남아 있다 (저장된 결과와 화면 일치)
  await page.reload();
  await learn(page);
  const rows = page.locator(".learn-dash-row");
  await expect(rows.first()).toContainText("응시 1회");
  await expect(page.locator('section[aria-label="진행 중인 퀴즈"]')).toHaveCount(0);
});

test("학습센터: 두 탭에서 같은 응시를 조작하면 먼저 저장한 탭이 보호된다", async ({ page, context }) => {
  await page.goto("/");
  await learn(page);
  const quizButtons = page.getByRole("button", { name: "퀴즈 응시", exact: true });
  await quizButtons.first().click();
  // 답변 가능한 첫 문항에 답변하고 그 위치를 기록
  let answeredIndex = -1;
  for (let i = 0; i < 10 && answeredIndex < 0; i++) {
    if ((await page.locator(".learn-choice, .learn-ox").count()) > 0) {
      await answerCurrent(page);
      answeredIndex = i;
    } else {
      await page.getByRole("button", { name: "다음", exact: true }).click();
    }
  }
  expect(answeredIndex).toBeGreaterThanOrEqual(0);
  await waitInProgressState(page, { answers: 1, currentIndex: answeredIndex });

  // 두 번째 탭: 진행 중 응시를 불러와 이어서 진행 (두 문항 더 이동)
  const page2 = await context.newPage();
  await page2.goto("/");
  await learn(page2);
  const resumeCard = page2.locator('section[aria-label="진행 중인 퀴즈"]');
  await expect(resumeCard).toBeVisible();
  await resumeCard.getByRole("button", { name: "이어서 응시하기", exact: true }).click();
  await page2.getByRole("button", { name: "다음", exact: true }).click();
  await page2.getByRole("button", { name: "다음", exact: true }).click();
  await waitInProgressState(page2, { answers: 1, currentIndex: answeredIndex + 2 });
  await page2.close();

  // 첫 번째 탭이 오래된 기준으로 저장을 시도하면 충돌 안내가 표시되고 덮어쓰지 않는다
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.locator(".learn-save-error")).toBeVisible();
  await expect(page.locator(".learn-save-error")).toContainText("다른 탭에서 같은 퀴즈가 진행 중입니다");
  // 저장된 기록은 두 번째 탭의 상태 그대로다
  await waitInProgressState(page, { answers: 1, currentIndex: answeredIndex + 2 });
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
  // 모바일에서는 메뉴 시트를 먼저 연다 (데스크톱은 사이드바 상시 표시)
  const menuButton = page.getByRole("button", { name: "작업 공간 메뉴 열기", exact: true });
  if (await menuButton.isVisible()) await menuButton.click();
  // AI•AX 그룹 내 메뉴 순서 확인
  const nav = page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true });
  const items = await nav.getByRole("button").allTextContents();
  const learnIdx = items.findIndex((t) => t.trim() === "학습센터");
  const axIdx = items.findIndex((t) => t.includes("업무 자동화 진단"));
  expect(learnIdx).toBeGreaterThanOrEqual(0);
  expect(axIdx).toBeGreaterThanOrEqual(0);
  expect(axIdx).toBe(learnIdx + 1);
});

/* ------------------------------------------------------------------ */
/* 최종 통합 개선 (종료 버튼·항목 완료·진단 연결·완료 화면·터미널 복구·백업) */
/* ------------------------------------------------------------------ */

/** IndexedDB에 학습 기록을 직접 심는다 (학습센터 마운트 전에 호출) */
async function seedLearnRecord(
  page: Parameters<typeof navigateWorkspace>[0],
  key: string,
  value: unknown,
) {
  await page.evaluate(
    async ([k, v]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("worklens-learn", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("progress")) req.result.createObjectStore("progress");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("progress", "readwrite");
          tx.objectStore("progress").put(v, k as string);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    [key, value] as const,
  );
}

function passedLevelRecord(level: number, finishedAt: number) {
  return {
    passed: true,
    bestScore: 90,
    attempts: [
      {
        attemptId: `seed-${level}`,
        level,
        questionIds: [],
        answers: {},
        graded: [],
        score: 90,
        passed: true,
        passScore: 80,
        startedAt: finishedAt - 1000,
        finishedAt,
      },
    ],
  };
}

test("학습센터: 퀴즈 종료 버튼 — 확인 취소 시 응시 유지, 확정 시 응시만 정리", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await page.getByRole("button", { name: "퀴즈 응시", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: /LEVEL 1 퀴즈/, exact: false })).toBeVisible();
  // 기존 "그만두기" 버튼은 없고, "종료" 버튼은 문항 번호 줄의 오른쪽 끝에 있다
  await expect(page.getByRole("button", { name: "그만두기", exact: true })).toHaveCount(0);
  const exitButton = page.locator(".learn-quiz-topnav").getByRole("button", { name: "종료", exact: true });
  await expect(exitButton).toBeVisible();
  // 하단 이전·다음 내비게이션에는 종료 버튼이 없다
  await expect(page.locator(".learn-quiz-nav").getByRole("button", { name: "종료", exact: true })).toHaveCount(0);
  await expect(page.locator(".learn-quiz-nav").getByRole("button", { name: "이전", exact: true })).toBeVisible();
  await expect(page.locator(".learn-quiz-nav").getByRole("button", { name: "다음", exact: true })).toBeVisible();
  // 1문항 답변 후 종료 확인 → 계속 풀기
  await answerCurrent(page);
  await exitButton.click();
  await expect(page.getByRole("heading", { name: "퀴즈를 종료할까요?" })).toBeVisible();
  await expect(page.getByText(/제출하지 않은 답변은 채점되지 않습니다/, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "계속 풀기", exact: true }).click();
  // 문제·답변·위치가 그대로 유지된다
  await expect(page.locator(".learn-assess-progress-text")).toHaveText("1 / 10 문항");
  await expect(page.locator(".learn-qdot.is-answered")).toHaveCount(1);
  // 다시 종료 → 종료하기 확정
  await exitButton.click();
  await page.getByRole("button", { name: "종료하기", exact: true }).click();
  await expect(page.locator(".learn-view").getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
  // 진행 중 응시는 정리되고, 완료 응시는 생성되지 않았다
  await expect(page.locator('section[aria-label="진행 중인 퀴즈"]')).toHaveCount(0);
  await expect(page.locator(".learn-dash-row").first()).not.toContainText("응시 1회");
  await expect.poll(() => readInProgressState(page), { timeout: 15_000 }).toBeNull();
});

test("학습센터: 학습 항목 완료 표시 — 위치 이동과 구분되고 새로고침 후 유지", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await openFirstLesson(page);
  await expect(page.getByText("완료한 항목 0 / 5", { exact: true })).toBeVisible();
  // 위치만 이동해서는 완료 처리되지 않는다
  const nav = page.locator(".learn-quiz-nav");
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByText("완료한 항목 0 / 5", { exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "이전", exact: true }).click();
  // 명시적으로 완료 표시
  await page.getByRole("button", { name: "학습 완료로 표시", exact: true }).click();
  await expect(page.getByText("이 항목의 학습을 완료했습니다", { exact: true })).toBeVisible();
  await expect(page.getByText("완료한 항목 1 / 5", { exact: true })).toBeVisible();
  await expect(page.locator(".learn-unit-btn.is-completed")).toHaveCount(1);
  // 새로고침 후에도 유지된다
  await page.reload();
  await learn(page);
  await expect(page.locator(".learn-dash-row").first()).toContainText("학습 항목 완료 1 / 5");
  await openFirstLesson(page);
  await expect(page.getByText("완료한 항목 1 / 5", { exact: true })).toBeVisible();
  // 완료 취소도 가능하다
  await page.getByRole("button", { name: "완료 취소", exact: true }).click();
  await expect(page.getByText("완료한 항목 0 / 5", { exact: true })).toBeVisible();
});

test("학습센터: 사전 진단 결과에서 관련 학습으로 직접 이동", async ({ page }) => {
  await page.goto("/");
  await learn(page);
  await page.getByRole("button", { name: "사전 진단 받기 (선택)", exact: true }).click();
  // 모든 문항에 일부러 오답을 선택한다 (문제은행 데이터 기준으로 정답이 아닌 선택지 클릭)
  for (let i = 0; i < DIAGNOSTIC_QUESTIONS.length; i++) {
    const q = DIAGNOSTIC_QUESTIONS[i];
    const correctIdx = (q.choices ?? []).findIndex((c) => q.correctChoiceIds?.includes(c.id));
    const wrongIdx = (q.choices ?? []).findIndex((_, idx) => idx !== correctIdx);
    await page.locator(".learn-choice").nth(wrongIdx).click();
    if (i < DIAGNOSTIC_QUESTIONS.length - 1) {
      await page.getByRole("button", { name: "다음", exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "결과 보기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "사전 진단 결과" })).toBeVisible();
  // 취약 영역마다 연결 학습과 학습하기 버튼이 표시된다
  const conceptArea = page.locator(".learn-diagnostic-area", { hasText: "AI·AX 개념 이해" });
  await expect(conceptArea).toContainText("연결 학습: LEVEL 1");
  // 잠긴 영역(LEVEL 4)은 안내 배너와 함께 대시보드로 돌아간다
  const cliArea = page.locator(".learn-diagnostic-area", { hasText: "CLI·Git 기본 지식" });
  await cliArea.getByRole("button", { name: "학습하기", exact: true }).click();
  await expect(page.locator(".learn-view").getByRole("heading", { name: "학습센터", exact: true })).toBeVisible();
  await expect(page.locator(".learn-save-error")).toContainText("아직 잠겨 있어");
  // 진단 기록은 대시보드에 보존되고, 거기서도 해제된 영역으로 이동할 수 있다
  const dashConcept = page.locator(".learn-diagnostic-area", { hasText: "AI·AX 개념 이해" });
  await dashConcept.getByRole("button", { name: "학습하기", exact: true }).click();
  await expect(page.locator(".learn-lesson-unit-title")).toContainText("생성형 AI와 대화형 AI");
});

test("학습센터: 전체 통과 시 학습 완료 확인 화면 (수료증 없음)", async ({ page }) => {
  const t1 = Date.UTC(2026, 9, 10, 12);
  const t2 = Date.UTC(2026, 9, 15, 12);
  const levels: Record<string, unknown> = {};
  for (let l = 1; l <= 9; l++) levels[String(l)] = passedLevelRecord(l, t1);
  levels["10"] = passedLevelRecord(10, t2);
  await page.goto("/");
  await seedLearnRecord(page, "current", { version: 1, levels, wrongAnswers: [], updatedAt: Date.now() });
  await learn(page);
  await expect(page.getByText(/10 \/ 10 단계 \(100%\)/, { exact: false })).toBeVisible();
  // 수료증 문구는 어디에도 없다
  await expect(page.getByText(/수료증/, { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "학습 완료 보기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "모든 학습을 완료했습니다" })).toBeVisible();
  await expect(page.getByText("10 / 10", { exact: true })).toBeVisible();
  // 최초 완료일은 응시 기록에서 복원한 실제 날짜 (LEVEL 10 최초 통과일)
  await expect(page.getByText("2026년 10월 15일", { exact: true })).toBeVisible();
  await expect(page.getByText(/언제든 다시 학습하고 퀴즈에 응시할 수 있습니다/, { exact: false })).toBeVisible();
  // 돌아가기 후 재진입해도 같은 날짜가 유지된다 (완료 화면 본문의 주요 버튼 사용)
  await page.locator(".learn-completion").getByRole("button", { name: "학습센터로 돌아가기", exact: true }).click();
  await page.getByRole("button", { name: "학습 완료 보기", exact: true }).click();
  await expect(page.getByText("2026년 10월 15일", { exact: true })).toBeVisible();
});

test("학습센터: LEVEL 10 최초 통과 결과에서 학습 완료 확인으로 이동", async ({ page }) => {
  const t1 = Date.UTC(2026, 9, 10, 12);
  const levels: Record<string, unknown> = {};
  for (let l = 1; l <= 9; l++) levels[String(l)] = passedLevelRecord(l, t1);
  await page.goto("/");
  await seedLearnRecord(page, "current", { version: 1, levels, wrongAnswers: [], updatedAt: Date.now() });
  await learn(page);
  await page.locator(".learn-dash-row").nth(9).getByRole("button", { name: "퀴즈 응시", exact: true }).click();
  await expect(page.getByRole("heading", { name: /LEVEL 10 퀴즈/, exact: false })).toBeVisible();
  // 진행 중 기록에서 출제 문항 순서를 읽어 문제은행 정답대로 답변한다
  await expect.poll(() => readInProgressState(page), { timeout: 15_000 }).not.toBeNull();
  const rawInProgress = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-learn", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<{ questionIds: string[] } | undefined>((resolve) => {
        const tx = db.transaction("progress", "readonly");
        const q = tx.objectStore("progress").get("in-progress");
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => resolve(undefined);
      });
    } finally {
      db.close();
    }
  });
  const bank = questionBank(10);
  const questionIds = rawInProgress?.questionIds ?? [];
  expect(questionIds).toHaveLength(20);
  const dots = page.getByRole("navigation", { name: "문항 이동" }).getByRole("button");
  for (let i = 0; i < questionIds.length; i++) {
    const question = bank.find((q) => q.id === questionIds[i]);
    expect(question, `문항 ${questionIds[i]}이 문제은행에 있어야 한다`).toBeDefined();
    for (const choiceId of question!.correctChoiceIds ?? []) {
      const choice = question!.choices?.find((c) => c.id === choiceId);
      await page
        .locator(".learn-choice", { hasText: choice!.text })
        .filter({ hasText: choice!.text })
        .first()
        .click();
    }
    if (i < questionIds.length - 1) await dots.nth(i + 1).click();
  }
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LEVEL 10 평가 결과" })).toBeVisible();
  await expect(page.getByText(/통과!/, { exact: false })).toBeVisible();
  // 결과 화면에서 학습 완료 확인으로 이동할 수 있다
  await page.getByRole("button", { name: "학습 완료 확인하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "모든 학습을 완료했습니다" })).toBeVisible();
  await expect(page.getByText("10 / 10", { exact: true })).toBeVisible();
});

test("학습센터: 퀴즈 터미널 실습 상태 저장·복구와 복원 상태 재검증", async ({ page }) => {
  const levels: Record<string, unknown> = {};
  for (let l = 1; l <= 3; l++) levels[String(l)] = passedLevelRecord(l, Date.UTC(2026, 9, 10, 12));
  await page.goto("/");
  await seedLearnRecord(page, "current", { version: 1, levels, wrongAnswers: [], updatedAt: Date.now() });

  // LEVEL 4 터미널 문항 + 객관식 2문항으로 진행 중 응시를 구성한다
  const bank4 = questionBank(4);
  const terminalQ = bank4.find((q) => q.id === "l4-q016");
  expect(terminalQ).toBeDefined();
  const others = bank4.filter((q) => q.choices && q.id !== "l4-q016").slice(0, 2);
  const questions = [terminalQ!, ...others];
  // 실습 중간 상태: mkdir + cd까지 수행한 상태
  let termState = initialStateForScenario("folder-nav");
  const transcript: { cmd: string; out: string[] }[] = [];
  for (const cmd of ["mkdir WorkLens", "cd WorkLens"]) {
    const r = executeCommand(termState, cmd);
    termState = r.state;
    transcript.push({ cmd, out: r.output });
  }
  const questionChecks: Record<string, number> = {};
  const choiceOrder: Record<string, string[]> = {};
  for (const q of questions) {
    questionChecks[q.id] = questionFingerprint(q);
    if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
  }
  await seedLearnRecord(page, "in-progress", {
    attemptId: "seed-terminal-attempt",
    level: 4,
    startedAt: Date.now() - 60_000,
    questionIds: questions.map((q) => q.id),
    choiceOrder,
    answers: {},
    currentIndex: 0,
    terminalStates: { "l4-q016": serializeTerminalState(termState, transcript) },
    passScore: 80,
    questionChecks,
    savedAt: Date.now(),
    status: "in-progress",
  });
  await learn(page);
  const resumeCard = page.locator('section[aria-label="진행 중인 퀴즈"]');
  await expect(resumeCard).toBeVisible();
  await resumeCard.getByRole("button", { name: "이어서 응시하기", exact: true }).click();
  // 터미널 상태가 복원된다 — 현재 경로가 WorkLens 안
  const terminalInput = page.getByLabel("가상 터미널 명령어 입력");
  await terminalInput.fill("pwd");
  await terminalInput.press("Enter");
  await expect(page.locator(".learn-terminal-output")).toContainText("C:\\Users\\학습자\\WorkLens");
  // 나머지 지시를 수행하고 완료 확인 → 성공
  await terminalInput.fill("cd ..");
  await terminalInput.press("Enter");
  await page.getByRole("button", { name: "과제 완료 확인", exact: true }).click();
  await expect(page.getByText(/과제 성공/, { exact: false })).toBeVisible();
  // 마지막 문항으로 이동해 제출하면 결과가 표시된다
  const dots = page.getByRole("navigation", { name: "문항 이동" }).getByRole("button");
  await dots.nth(questions.length - 1).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LEVEL 4 평가 결과" })).toBeVisible();
});

test("학습센터: 저장된 터미널 성공 여부는 복원 상태로 재검증된다", async ({ page }) => {
  const levels: Record<string, unknown> = {};
  for (let l = 1; l <= 3; l++) levels[String(l)] = passedLevelRecord(l, Date.UTC(2026, 9, 10, 12));
  await page.goto("/");
  await seedLearnRecord(page, "current", { version: 1, levels, wrongAnswers: [], updatedAt: Date.now() });
  const bank4 = questionBank(4);
  const terminalQ = bank4.find((q) => q.id === "l4-q016")!;
  const others = bank4.filter((q) => q.choices && q.id !== "l4-q016").slice(0, 2);
  const questions = [terminalQ, ...others];
  const questionChecks: Record<string, number> = {};
  const choiceOrder: Record<string, string[]> = {};
  for (const q of questions) {
    questionChecks[q.id] = questionFingerprint(q);
    if (q.choices) choiceOrder[q.id] = q.choices.map((c) => c.id);
  }
  // 답변에는 passed=true가 저장돼 있지만 실제 터미널 상태는 초기 상태(조건 미충족)
  const initial = initialStateForScenario("folder-nav");
  await seedLearnRecord(page, "in-progress", {
    attemptId: "seed-terminal-fake",
    level: 4,
    startedAt: Date.now() - 60_000,
    questionIds: questions.map((q) => q.id),
    choiceOrder,
    answers: { "l4-q016": { kind: "terminal", passed: true } },
    currentIndex: 0,
    terminalStates: { "l4-q016": serializeTerminalState(initial, []) },
    passScore: 80,
    questionChecks,
    savedAt: Date.now(),
    status: "in-progress",
  });
  await learn(page);
  const resumeCard = page.locator('section[aria-label="진행 중인 퀴즈"]');
  await resumeCard.getByRole("button", { name: "이어서 응시하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: /LEVEL 4 퀴즈/, exact: false })).toBeVisible();
  // 아무것도 더 하지 않고 제출 — 복원 상태가 조건을 충족하지 않으므로 터미널 문항은 오답
  const dots = page.getByRole("navigation", { name: "문항 이동" }).getByRole("button");
  await dots.nth(questions.length - 1).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await page.getByRole("button", { name: "제출하고 채점하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LEVEL 4 평가 결과" })).toBeVisible();
  await expect(page.locator(".learn-result-score")).toHaveText("0점");
});

test("학습센터: 연습 터미널 상태가 단위 이동·새로고침 후에도 복구된다", async ({ page }) => {
  const levels: Record<string, unknown> = {};
  for (let l = 1; l <= 3; l++) levels[String(l)] = passedLevelRecord(l, Date.UTC(2026, 9, 10, 12));
  await page.goto("/");
  await seedLearnRecord(page, "current", { version: 1, levels, wrongAnswers: [], updatedAt: Date.now() });
  await learn(page);
  await page.locator(".learn-dash-row").nth(3).getByRole("button", { name: "이어서 학습", exact: true }).click();
  await expect(page.getByRole("heading", { name: /LEVEL 4 ·/, exact: false })).toBeVisible();
  const terminalInput = page.getByLabel("가상 터미널 명령어 입력");
  await expect(terminalInput).toBeVisible();
  await terminalInput.fill("mkdir PracticeFolder");
  await terminalInput.press("Enter");
  await terminalInput.fill("dir");
  await terminalInput.press("Enter");
  await expect(page.locator(".learn-terminal-output")).toContainText("PracticeFolder");
  // 연습 상태가 저장될 때까지 대기
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open("worklens-learn", 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          try {
            const value: Record<string, { dirs?: string[] }> | undefined = await new Promise((resolve) => {
              const tx = db.transaction("progress", "readonly");
              const q = tx.objectStore("progress").get("practice-terminal");
              q.onsuccess = () => resolve(q.result);
              q.onerror = () => resolve(undefined);
            });
            return JSON.stringify(value ?? {}).includes("PracticeFolder");
          } finally {
            db.close();
          }
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  // 다른 단위로 이동했다가 돌아와도, 새로고침해도 연습 상태가 유지된다
  const unitNav = page.getByRole("navigation", { name: "학습 단위" });
  await unitNav.getByRole("button", { name: /^2\. / }).click();
  await unitNav.getByRole("button", { name: /^1\. / }).click();
  await expect(page.locator(".learn-terminal-output")).toContainText("PracticeFolder");
  await page.reload();
  await learn(page);
  await page.locator(".learn-dash-row").nth(3).getByRole("button", { name: "이어서 학습", exact: true }).click();
  await expect(page.locator(".learn-terminal-output")).toContainText("PracticeFolder");
});

test("학습센터: JSON 백업 내보내기·가져오기와 손상 파일 거부", async ({ page }, testInfo) => {
  const t1 = Date.UTC(2026, 9, 10, 12);
  const level1 = {
    ...passedLevelRecord(1, t1),
    lastStudiedUnitId: "l1-u2",
    completedUnitIds: ["l1-u1"],
  };
  await page.goto("/");
  await seedLearnRecord(page, "current", {
    version: 1,
    levels: { "1": level1 },
    wrongAnswers: [
      { questionId: "l1-q001", level: 1, category: "AI 기초", attemptId: "seed-1", answeredAt: t1, reviewCount: 0 },
    ],
    updatedAt: Date.now(),
  });
  await learn(page);
  await expect(page.getByText(/1 \/ 10 단계 \(10%\)/, { exact: false })).toBeVisible();

  // 내보내기 — 다운로드 파일을 검증한다
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "학습 기록 내보내기", exact: true }).click();
  const download = await downloadPromise;
  const tmpDir = (await import("node:path")).join(testInfo.project.outputDir, "learn-backup-tmp");
  (await import("node:fs")).mkdirSync(tmpDir, { recursive: true });
  const backupPath = (await import("node:path")).join(tmpDir, "learn-backup.json");
  await download.saveAs(backupPath);
  const backupText = await import("node:fs").then((fs) => fs.readFileSync(backupPath, "utf8"));
  const backupJson = JSON.parse(backupText) as {
    format: string;
    formatVersion: number;
    data: { progress: { levels: Record<string, { passed: boolean }> } };
  };
  expect(backupJson.format).toBe("worklens-learn-backup");
  expect(backupJson.formatVersion).toBe(1);
  expect(backupJson.data.progress.levels["1"].passed).toBe(true);

  // 기록을 비우고 새로고침 → 빈 상태
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("worklens-learn", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction("progress", "readwrite");
        tx.objectStore("progress").delete("current");
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } finally {
      db.close();
    }
  });
  await page.reload();
  await learn(page);
  await expect(page.getByText(/0 \/ 10 단계 \(0%\)/, { exact: false })).toBeVisible();

  // 손상 파일은 거부되고 기존(빈) 기록이 유지된다
  const brokenPath = (await import("node:path")).join(tmpDir, "broken.json");
  writeFileSync(brokenPath, "{ this is not json", "utf8");
  await page.locator('.learn-view input[type="file"]').setInputFiles(brokenPath);
  await expect(page.getByRole("heading", { name: "학습 기록을 가져올 수 없습니다" })).toBeVisible();
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText(/0 \/ 10 단계 \(0%\)/, { exact: false })).toBeVisible();

  // 정상 백업 가져오기 → 교체 확인 후 복원된다
  await page.locator('.learn-view input[type="file"]').setInputFiles(backupPath);
  await expect(page.getByRole("heading", { name: "학습 기록을 가져올까요?" })).toBeVisible();
  await page.getByRole("button", { name: "기존 기록을 교체하고 가져오기", exact: true }).click();
  await expect(page.getByText(/1 \/ 10 단계 \(10%\)/, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /오답 노트 \(1\)/, exact: false })).toBeVisible();
  await expect(page.locator(".learn-dash-row").first()).toContainText("학습 항목 완료 1 / 5");
});
