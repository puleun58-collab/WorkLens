import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture } from "../fixtures/ax";

async function registerAndDiagnose(page: Page) {
  const diagnosis = outputFixture();
  diagnosis.asIs.steps = [...diagnosis.asIs.steps, "별도 수동 매칭"];
  diagnosis.technicalChecks = [
    { topic: "시스템 접근", status: "확인 필요", note: "API와 권한 실제 확인" },
    { topic: "D4 결과 상태", status: "확인 필요", note: "결과 상태 목록 미확정" },
    { topic: "외부 전송 조건", status: "확인 필요", note: "HITL 검토 필요: 외부 전송 전 확인" },
    { topic: "구현 계획 검토", status: "확인 필요", note: "계획 항목 검토" },
    { topic: "업무 정보 누락", status: "확인 필요", note: "업무 설명 보완 필요" },
  ];
  await page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
  await page.getByLabel("업무명", { exact: true }).fill("운송장 검증");
  await page.getByLabel("업무 설명", { exact: true }).fill("운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
}

async function confirmDecision(page: Page, rowPattern: RegExp, rowId: string) {
  // 기본은 모두 접힘이므로, 이미 펼쳐진 행은 다시 클릭하지 않는다(접힘 방지).
  const head = page.getByRole("button", { name: rowPattern });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await page.locator(`#ax-decision-${rowId}`).getByLabel("상태").selectOption("확정");
}

test("AX 간소화·COSS 통일: 판단 하단 문구 제거·매트릭스 버튼 제거·다음 행동 형식·로드맵 헤더·확인사항 이동", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page);

  // A. 판단 표에 없는 AS-IS 단계 문구가 표시되지 않는다.
  await expect(page.getByText(/판단 표에 없는 AS-IS 단계/)).toHaveCount(0);

  // D3·D4·D5·D6 확정 → step 4에 예시 미확정 항목이 생기지 않는다 (예시 체계 제거).
  // (고정 7개가 아니라 진단에서 도출된 후보 행만 표시되므로, 신호가 없는 D1·D2·D7 행은 없다.)
  await confirmDecision(page, /D3 예외값 처리/, "D3");
  await confirmDecision(page, /D4 결과 상태/, "D4");
  await confirmDecision(page, /D5 판단 불가 처리/, "D5");
  await confirmDecision(page, /D6 빈 파일 처리/, "D6");
  await page.locator('section[aria-label="업무 규칙 확인"]').getByRole("button", { name: "저장", exact: true }).click();
  // D 4건 확정 / D 분모 4건 + 범용 후보 적용 여부 확인 5건(기술적 확인 4건 + 사람 판단 1건).
  await expect(page.locator('section[aria-label="업무 규칙 확인"]').getByText("4/4 확인 완료 · 적용 여부 확인 5건", { exact: true })).toBeVisible();

  // B. 매트릭스 상세 카드 자체가 §9로 제거됐다 (이동 버튼 제거를 넘어 카드 자체가 없음).
  // 이동은 상단 단계 내비게이션으로 한다.
  await page.getByRole("button", { name: "다음 단계" }).click();
  await expect(page.locator(".ax-matrix-surface")).toBeVisible();
  await expect(page.locator('section[aria-label$="매트릭스 상세"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "업무 진단으로 이동" })).toHaveCount(0);

  // C·D. 결과·로드맵: 다음 행동 형식, 로드맵 헤더 버튼 제거(§5.1), 계획 헤더 중복 제거.
  await page.getByRole("button", { name: "다음 단계" }).click();
  const nextAction = page.locator(".ax-next-action").first();
  await expect(nextAction).toBeVisible();
  await expect(nextAction).not.toContainText("먼저 확인");
  await expect(nextAction).not.toContainText("—");
  await expect(nextAction).toContainText("다음 행동");
  await expect(page.locator(".ax-report-intro").getByRole("button", { name: "업무 진단으로 이동" })).toHaveCount(0);
  await expect(page.locator("#ax-plan-section .ax-plan-head")).not.toContainText("운송장 검증");

  const precheck = page.locator('section[aria-label="구현 전 확인"]');
  await expect(precheck).toBeVisible();
  // 반복 문구 제거: 기존 "업무 진단에서 확인" 버튼은 precheck에 남아 있지 않다.
  await expect(precheck.getByRole("button", { name: "업무 진단에서 확인" })).toHaveCount(0);
  // 요약 전용: ①에는 상세 문구가 없고 미해결 건수 배지만 표시된다.
  await expect(precheck.getByText("업무 처리 예시 미확정")).toHaveCount(0);
  await expect(precheck).not.toContainText("업무 처리 예시 미확정");
  await expect(precheck.locator(".ax-precheck-head")).toContainText(/미해결 \d+건/);

  // E. ①에는 헤더 펼침 토글 버튼 1개만 있고, 항목별 이동 버튼은 없다.
  // 각 목적지는 단계 내비게이션과 진단 화면에서 도달한다.
  await expect(precheck.getByRole("button")).toHaveCount(1);
  await expect(precheck.getByRole("button", { name: "계획 검토" })).toHaveCount(0);
  await expect(precheck.getByRole("button", { name: "HITL 검토" })).toHaveCount(0);
  await expect(precheck.getByRole("button", { name: "규칙 확인" })).toHaveCount(0);
  await expect(precheck.getByRole("button", { name: "예시 확인" })).toHaveCount(0);
  // 펼치면 실제 미해결 항목이 보이고, 항목별 이동 버튼은 생기지 않는다.
  // 표시 건수는 배지 건수와 같다 (같은 집계 기준).
  await precheck.getByRole("button", { name: /구현 전 확인/ }).click();
  await expect(precheck.locator(".ax-precheck-items")).toBeVisible();
  const badgeText = await precheck.locator(".ax-precheck-head").textContent();
  const badgeCount = Number(/미해결 (\d+)건/.exec(badgeText ?? "")?.[1]);
  await expect(precheck.locator(".ax-precheck-row")).toHaveCount(badgeCount);
  await expect(precheck.getByRole("button")).toHaveCount(1);
  await expect(precheck.getByRole("button", { name: "계획 검토" })).toHaveCount(0);
  await expect(precheck.getByRole("button", { name: "업무 정보 수정" })).toHaveCount(0);

  // E. 계획 검토 표는 결과·로드맵 화면 자체에 있다 (버튼 없이 직접 확인).
  await page.getByRole("button", { name: "Codex용 구현 계획 생성" }).click();
  await expect(page.getByRole("heading", { name: "구현 계획 검토" })).toBeVisible();
  await expect(page.locator('section[aria-label="구현 계획 검토"]')).toContainText("검토 필요");
  await page.locator("#ax-plan-review").scrollIntoViewIfNeeded();
  await expect(page.locator("#ax-plan-review")).toBeInViewport();

  // E. HITL 검토·결정 지점·예시는 업무 진단 단계에서 도달한다.
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.locator("#ax-step-review").scrollIntoViewIfNeeded();
  await expect(page.locator("#ax-step-review")).toBeInViewport();
  await page.locator("#ax-decision-D4 .ax-decision-row-head").click();
  await expect(page.locator("#ax-decision-D4 .ax-decision-row-head")).toHaveAttribute("aria-expanded", "true");

  // E. 범용 규칙 저장 후 결과·로드맵 복귀: 규칙을 저장하고 로드맵으로 돌아가면 같은 업무가 유지된다.
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  const dialog = page.locator('[data-slot="dialog-popup"]');
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "규칙 추가" })).toBeVisible();
  await dialog.getByLabel(/규칙명/).fill("운송장 중복 기준");
  await dialog.getByLabel("분류 *").selectOption("처리·판단 기준");
  await dialog.getByLabel("적용 여부 *").selectOption("적용 여부 미확정");
  await dialog.getByLabel("확정 상태 *").selectOption("미확정");
  await dialog.getByRole("button", { name: "추가", exact: true }).click();
  await unified.getByRole("button", { name: "저장", exact: true }).click();
  await expect(unified.getByText("업무 규칙을 저장했습니다.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "결과·로드맵", exact: true }).click();
  await expect(page.locator(".ax-report-intro h2")).toContainText("운송장 검증");
  await expect(precheck).toBeVisible();

  // E. 업무 정보 수정은 업무 진단 화면의 등록 정보 수정 버튼으로 이동한다.
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.locator(".ax-diag-card", { hasText: "운송장 검증" }).getByRole("button", { name: "등록 정보 수정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "등록 정보 수정" })).toBeVisible();
  await expect(page.getByLabel("업무명", { exact: true })).toHaveValue("운송장 검증");
});

test("AX 간소화·COSS 통일: 모바일 390에서 목록·다음 행동이 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAndDiagnose(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  const nextAction = page.locator(".ax-next-action").first();
  await expect(nextAction).toBeVisible();
  await expect(nextAction).not.toContainText("먼저 확인");
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(391);
});
