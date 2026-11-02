import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";
import { addInlineRule, chooseOption } from "./ax-rules";

async function registerAndDiagnose(page: Page, name: string, description: string, diagnosis = outputFixture()) {
  await page.route("**/api/ai", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByLabel("업무명", { exact: true }).fill(name);
  await page.getByLabel("업무 설명", { exact: true }).fill(description);
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
}

test("AX 진단 간소화: D1~D7 아코디언 단일 펼침·진행률·저장·재조회", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const decision = page.locator('section[aria-label="업무 규칙 확인"]');
  // 고정 7개가 아니라 진단에서 도출된 D3·D4·D5·D6 후보 4건과
  // 최종 승인 범용 후보 1건, 표시된 모든 규칙 5건이 검토 완료율 분모다.
  await expect(decision.getByText("0/5 완료", { exact: true })).toBeVisible();
  await expect(decision.locator(".ax-decision-row")).toHaveCount(5);
  for (const id of ["D3", "D4", "D5", "D6"]) {
    const row = decision.locator(`#ax-decision-${id}`);
    await expect(row).toBeVisible();
    await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
    await expect(row.getByText("제안", { exact: true })).toHaveCount(0);
  }
  const approval = decision.locator(".ax-decision-row").filter({ has: page.getByText("최종 승인", { exact: true }) });
  await expect(approval.getByText("제안", { exact: true })).toBeVisible();
  await expect(approval.locator(".ax-decision-badge")).toHaveText("미확정");
  await expect(decision).not.toContainText("적용 확인");

  // 기본은 모두 접힘이므로 D3 행을 펼쳐 입력한다. D4를 펼치면 D3이 접히고,
  // 다시 D3을 펼쳐도 미저장 입력이 유지된다.
  await page.getByRole("button", { name: /D3 예외 처리/ }).click();
  await chooseOption(page.locator("#ax-decision-D3"), "상태", "확정");
  await page.locator("#ax-decision-D3").getByLabel("예외 처리 기준").fill("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
  await expect(decision.locator(".ax-decision-counter")).toContainText("/ 2000");
  await page.getByRole("button", { name: /D4 결과 상태/ }).click();
  await expect(page.locator("#ax-decision-D3").getByLabel("예외 처리 기준")).toBeHidden();
  await expect(page.locator("#ax-decision-D4").getByRole("combobox", { name: "상태", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /D3 예외 처리/ }).click();
  await expect(page.locator("#ax-decision-D3").getByLabel("예외 처리 기준")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");

  // D규칙 상태 선택지는 확정 → 미확정 두 가지이고 기본값은 미확정이다.
  await page.getByRole("button", { name: /D4 결과 상태/ }).click();
  const d4Status = page.locator("#ax-decision-D4").getByRole("combobox", { name: "상태" });
  await expect(d4Status).toHaveText("미확정");
  await d4Status.click();
  await expect(page.getByRole("option")).toHaveText(["확정", "미확정"]);
  await page.keyboard.press("Escape");
  await expect(page.locator("#ax-decision-D4").getByLabel("상태 구분 기준")).toBeVisible();

  // 저장 후 진행률 갱신 + 저장 플러시 확인 후 새로고침 후 재조회.
  // 통합 저장 1회로 D 변경값과 범용 규칙이 함께 저장된다. 미터치 범용 후보는
  // 저장되지 않아 다음 렌더링에서 다시 도출된다.
  await decision.getByRole("button", { name: "저장", exact: true }).click();
  await expect(decision.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
  await expect(decision.getByText("1/5 완료", { exact: true })).toBeVisible();
  // useAxState 저장은 디바운스되므로 플러시될 때까지 poll한 뒤 새로고침한다 (즉시 새로고침하면 저장 전 상태로 복원된다).
  await expect.poll(async () => {
    const value = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
      const record = await new Promise<Record<string, unknown> | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
      db.close();
      return record;
    });
    const task = (value?.tasks as Array<Record<string, unknown>> | undefined)?.[0];
    const points = (task?.diagnosis as Record<string, unknown> | undefined)?.decisionPoints as Array<Record<string, unknown>> | undefined;
    const rules = task?.genericRules as Array<Record<string, unknown>> | undefined;
    return points?.find(point => point.id === "D3")?.status === "확정" && !rules?.length;
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  // 새로고침하면 셸 뷰가 기본값(문서 분석)으로 돌아가므로 AX 화면으로 다시 이동한다 (기존 reload 패턴과 동일).
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
  await page.getByRole("button", { name: /D3 예외 처리/ }).click();
  await expect(page.locator("#ax-decision-D3").getByRole("combobox", { name: "상태" })).toHaveText("확정");
  await expect(page.locator("#ax-decision-D3").getByLabel("예외 처리 기준")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
});

test("AX 진단 간소화: 통합 규칙 인라인 추가·아코디언 초안 유지·삭제·저장", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  // 진단에서 도출된 범용 후보가 제안 행으로 보이고, 출처 배지·근거 문구는 기본 화면에 없다.
  await expect(unified.getByText("최종 승인", { exact: true })).toBeVisible();
  await expect(unified.getByText("시스템 접근", { exact: true })).toHaveCount(0);
  await expect(unified.getByText("진단에서 도출", { exact: true })).toHaveCount(0);
  await expect(unified.getByText("AI 추천", { exact: true })).toHaveCount(0);
  // 규칙 추가는 모달 없이 목록 맨 아래 인라인 신규 항목으로 열린다.
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  await expect(page.locator('[data-slot="dialog-popup"]')).toHaveCount(0);
  const newRow = unified.locator("#ax-rule-new");
  await expect(newRow).toBeVisible();
  await expect(newRow.getByText("신규", { exact: true })).toBeVisible();
  await expect(unified.locator(".ax-decision-row").last()).toHaveAttribute("id", "ax-rule-new");
  // 필수 항목 없이 추가하면 기본 입력 영역에서 바로 오류를 표시한다. 확정 상태는 처음부터 미확정이다.
  await expect(newRow.getByRole("combobox", { name: "확정 상태" })).toHaveCount(0);
  await expect(newRow.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
  await expect(newRow.getByRole("combobox", { name: "업무 적용 여부" })).toHaveText("선택하세요");
  await newRow.getByRole("button", { name: "추가", exact: true }).click();
  await expect(newRow.getByText("규칙명을 입력하세요")).toBeVisible();
  await expect(newRow.getByText("분류를 선택하세요")).toBeVisible();
  // 취소하면 작성 중인 신규 항목만 사라진다.
  await newRow.getByRole("button", { name: "취소", exact: true }).click();
  await expect(newRow).toHaveCount(0);
  await expect(unified.getByText("최종 승인", { exact: true })).toBeVisible();
  for (const name of ["규칙 A", "규칙 B"]) await addInlineRule(unified, { name, category: "처리·판단 기준", applicability: "적용 여부 미확정", status: "미확정" });
  // 행을 접었다 펼쳐도 작성 중인 입력값이 사라지지 않는다.
  await unified.getByRole("button", { name: /R1 규칙 A/ }).click();
  await expect(unified.getByLabel("규칙명")).toHaveValue("규칙 A");
  await unified.getByRole("button", { name: /R2 규칙 B/ }).click();
  await expect(unified.getByLabel("규칙명")).toHaveValue("규칙 B");
  // 규칙 1 삭제 후 남은 규칙은 R2로 유지되고 규칙 B를 유지한다 (id 재부여 없음).
  await unified.getByRole("button", { name: /R1 규칙 A/ }).click();
  await unified.getByRole("button", { name: "이 규칙 삭제" }).click();
  await expect(unified.getByText("규칙 A")).toHaveCount(0);
  await expect(unified.getByText("규칙 B")).toBeVisible();
  await unified.getByRole("button", { name: "저장", exact: true }).click();
  await expect(unified.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
  // useAxState 저장은 디바운스되므로 플러시될 때까지 poll한 뒤 새로고침한다 (즉시 새로고침하면 저장 전 상태로 복원된다).
  await expect.poll(async () => {
    const value = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
      const record = await new Promise<Record<string, unknown> | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
      db.close();
      return record;
    });
    const task = (value?.tasks as Array<Record<string, unknown>> | undefined)?.[0];
    const rules = task?.genericRules as Array<Record<string, unknown>> | undefined;
    return rules?.length === 1 && rules?.[0]?.name === "규칙 B" && rules?.[0]?.id === "R2";
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  // 새로고침하면 셸 뷰가 기본값(문서 분석)으로 돌아가므로 AX 화면으로 다시 이동한다 (기존 reload 패턴과 동일).
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
  await expect(page.locator('section[aria-label="업무 규칙 확인"]').getByText("규칙 B")).toBeVisible();
});

test("AX 진단 간소화: 매트릭스 상세 카드 제거·Factor 근거는 업무 진단 단계에서 확인·업무 전환 갱신", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "업무 A", "업무 A 설명: 반복 입력 자료를 취합해 결과를 출력한다.");
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await page.getByLabel("업무명", { exact: true }).fill("업무 B");
  await page.getByLabel("업무 설명", { exact: true }).fill("업무 B 설명: 반복 입력 자료를 취합해 결과를 출력한다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();

  // 매트릭스 상세 카드 자체가 §9로 제거됐다: 점수 카드·점수 근거 펼침이 매트릭스 단계에 없다.
  await expect(page.locator(".ax-matrix-detail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "점수 근거 확인", exact: true })).toHaveCount(0);
  await expect(page.locator(".ax-score-factor")).toHaveCount(0);
  // 다른 업무 선택 시 목록 행 선택과 클러스터 선택 표시가 해당 업무로 갱신된다.
  // 두 업무는 동일 좌표라 하나의 그룹 마커를 공유한다.
  const list = page.getByLabel("매트릭스 업무 목록", { exact: true });
  await list.getByRole("button", { name: /업무 A/ }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "업무 A" }).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.ax-matrix-cluster[data-selected="true"]')).toHaveCount(1);

  // Factor 근거는 업무 진단 단계의 진단 항목 상세에서 확인한다(6개 Factor).
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  await expect(page.locator(".ax-factor-row")).toHaveCount(6);

  // 진단 단계: AS-IS 도식 제거, 단계별 판단 표가 단일 목록이다.
  await expect(page.locator(".ax-process-flow")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "단계별 자동화 판단", exact: true })).toBeVisible();
});

test("AX 진단 간소화: 모바일 390에서 인라인 규칙 추가·범용 패널에 가로 넘침이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  // 완료 현황 → 진행 바 → 규칙 추가 버튼 순서로 쌓이고, 버튼은 문구 너비에 맞춰 우측 정렬된다.
  const head = await unified.locator(".ax-decision-progress").evaluate(element => {
    const [text, bar, button] = [element.querySelector("strong")!, element.querySelector(".ax-decision-bar")!, element.querySelector("button")!].map(node => node.getBoundingClientRect());
    const box = element.getBoundingClientRect();
    return { order: text.bottom <= bar.top + 1 && bar.bottom <= button.top + 1, right: Math.abs(button.right - box.right) <= 1, narrow: button.width < box.width / 2 };
  });
  expect(head).toEqual({ order: true, right: true, narrow: true });
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const newRow = unified.locator("#ax-rule-new");
  await expect(newRow.getByRole("button", { name: "추가 정보 (선택)" })).toHaveCount(0);
  await chooseOption(newRow, "업무 적용 여부", "적용");
  await expect(newRow.getByRole("button", { name: "확정", exact: true })).toBeDisabled();
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await newRow.getByRole("button", { name: "취소", exact: true }).click();
  // 범용 후보 행을 펼쳐도 가로 넘침이 없다.
  await unified.getByRole("button", { name: /최종 승인/ }).click();
  await expect(page.locator(".ax-generic-panel")).toBeVisible();
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("AX 업무 규칙 검토 완료율: 미적용 결정은 완료, 선택 전은 미완료, 배지는 미확정/확정/미적용, 저장 후 유지", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  const row = unified.locator(".ax-decision-row").filter({ hasText: "최종 승인" });
  await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
  await row.locator(".ax-decision-row-head").click();
  // 미선택 상태는 "선택하세요"로 보이고, 후보 근거 문구는 표시하지 않는다.
  await expect(row.getByRole("combobox", { name: "업무 적용 여부" })).toHaveText("선택하세요");
  await expect(row).not.toContainText("후보 근거");
  // 도출 규칙의 규칙명·분류 입력과 수정 버튼은 표시하지 않는다. 기존 값은 저장 후에도 보존된다.
  await expect(row.getByLabel("규칙명")).toHaveCount(0);
  await expect(row.getByRole("combobox", { name: "분류" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "규칙명·분류 수정" })).toHaveCount(0);
  await chooseOption(row, "업무 적용 여부", "미적용");
  await expect(row.locator(".ax-decision-badge")).toHaveText("미적용");
  await expect(unified.getByText("1/5 완료", { exact: true })).toBeVisible();
  // 다시 적용으로 바꾸면 확정 전이므로 미완료로 돌아간다.
  await chooseOption(row, "업무 적용 여부", "적용");
  await expect(unified.getByText("0/5 완료", { exact: true })).toBeVisible();
  await chooseOption(row, "업무 적용 여부", "미적용");
  await unified.getByRole("button", { name: "저장", exact: true }).click();
  await expect(unified.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const record = await new Promise<{ tasks?: Array<{ genericRules?: Array<{ applicability: string }> }> } | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close();
    return record?.tasks?.[0]?.genericRules?.[0]?.applicability;
  }), { timeout: 10_000 }).toBe("해당 없음");
  await page.reload();
  await navigateWorkspace(page, "업무 자동화 진단");
  const reloaded = page.locator('section[aria-label="업무 규칙 확인"]');
  await expect(reloaded.getByText("1/5 완료", { exact: true })).toBeVisible();
  // 저장 후에도 도출 규칙의 규칙명·분류는 보존되고(카드 제목·보조 문구), 입력창은 기본 숨김이다.
  const saved = reloaded.locator(".ax-decision-row").filter({ hasText: "최종 승인" });
  await expect(saved).toContainText("권한·검토 기준");
  await saved.locator(".ax-decision-row-head").click();
  await expect(saved.getByLabel("규칙명")).toHaveCount(0);
  await expect(saved.getByRole("combobox", { name: "분류" })).toHaveCount(0);
});

test("AX D규칙 과거 '해당 없음' 저장값은 미적용으로 그대로 보이고, 확정/미확정으로 바꿀 수 있다 (자동 변환 없음)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const task = taskFixture("legacy-na", { ...diagnosisFixture, decisionPoints: [...(diagnosisFixture.decisionPoints ?? []).filter(point => point.id !== "D4"), { id: "D4", status: "해당 없음" }] });
  await page.evaluate(async state => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onupgradeneeded = () => req.result.createObjectStore("state"); req.onsuccess = () => resolve(req.result); });
    await new Promise<void>(resolve => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(state, "current"); tx.oncomplete = () => resolve(); });
    db.close();
  }, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  const d4 = unified.locator("#ax-decision-D4");
  await expect(d4.locator(".ax-decision-badge")).toHaveText("미적용");
  await unified.getByRole("button", { name: /D4 결과 상태/ }).click();
  const status = d4.getByRole("combobox", { name: "상태" });
  await expect(status).toHaveText("미적용");
  await status.click();
  await expect(page.getByRole("option")).toHaveText(["확정", "미확정", "미적용"]);
  await page.getByRole("option", { name: "미확정", exact: true }).click();
  await expect(d4.getByLabel("상태 구분 기준")).toBeVisible();
  // 다른 값으로 바꾼 뒤에는 일반 D규칙과 같은 두 가지 선택지만 남는다.
  await status.click();
  await expect(page.getByRole("option")).toHaveText(["확정", "미확정"]);
  await page.keyboard.press("Escape");
});

test("AX 진단 결과 요약: 판정 3카드는 실제 건수, 확인 필요 · N건과 바로가기, 구현 전 확인 사항은 미확인 우선·확인 완료 접힘", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const diagnosis = { ...outputFixture(), technicalChecks: [...outputFixture().technicalChecks, { topic: "계산 로직 구현 환경", status: "확인됨" as const, note: "Python 스크립트 사용 가능" }] };
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.", diagnosis);
  const steps = diagnosis.stepAssessments;
  const cards = page.locator(".ax-diag-card .ax-verdict-card");
  await expect(cards).toHaveCount(4);
  for (const [index, verdict, label] of [[0, "자동화", "자동화 적합"], [1, "AI 보조", "AI 보조 적합"], [2, "사람 유지", "담당자 수행"]] as const) {
    await expect(cards.nth(index).locator("dt")).toHaveText(label);
    await expect(cards.nth(index).locator("dd strong")).toHaveText(String(steps.filter(step => step.verdict === verdict).length));
  }
  // 상세 헤더: Gate 배지가 Level 배지보다 먼저다.
  await expect(page.locator(".ax-diag-badges > *").first()).toHaveClass(/ax-gate-badge/);
  const card = page.locator(".ax-diag-card");
  await expect(card).not.toContainText("사용자 등록 정보 기반 진단");
  await expect(card).not.toContainText("다음 단계");
  const checks = page.locator(".ax-diag-checks");
  await expect(checks.getByRole("heading", { name: "구현 전 확인 사항" })).toBeVisible();
  // 미확인 목록에는 확인됨 항목이 없고, 상단·목록 제목 건수는 미확인 행 수와 같다.
  const pending = checks.locator(":scope > ul > li");
  const pendingCount = await pending.count();
  expect(pendingCount).toBeGreaterThan(0);
  await expect(pending.locator('.ax-check-badge[data-kind="done"]')).toHaveCount(0);
  await expect(checks.locator(".ax-diag-checks-head")).toContainText(`· ${pendingCount}건`);
  // 네 번째 요약 카드: 구현 전 확인 미확인 건수(목록과 같은 집계)와 목록 이동 버튼.
  const checkCard = cards.nth(3);
  await expect(checkCard.locator("dt")).toHaveText("확인 필요");
  await expect(checkCard.locator("dd")).toHaveText(`${pendingCount}건`);
  await checkCard.getByRole("button", { name: "항목 보기", exact: true }).click();
  await expect.poll(() => checks.evaluate(node => Math.abs(node.getBoundingClientRect().top - 96))).toBeLessThan(40);
  // 확인 완료 항목은 기본 접힘이고, 펼치면 기존 정보가 그대로 보인다.
  const done = checks.getByRole("button", { name: "확인 완료 항목 보기 (1건)" });
  await expect(done).toHaveAttribute("aria-expanded", "false");
  await expect(checks.getByText("계산 로직 구현 환경")).toBeHidden();
  await done.click();
  await expect(checks.getByText("계산 로직 구현 환경")).toBeVisible();
  await expect(checks.getByText("Python 스크립트 사용 가능")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const width of [1440, 390]) {
  test(`AX D규칙 패널 정렬: ${width}px에서 제목 시작선과 대칭 여백`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
    const row = page.locator("#ax-decision-D3");
    await row.locator(".ax-decision-row-head").click();
    const geometry = await row.evaluate(element => {
      const panel = element.querySelector(".ax-decision-panel")!;
      const title = element.querySelector(".ax-decision-title strong")!.getBoundingClientRect();
      const label = panel.querySelector("label")!.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return { titleX: title.x, labelX: label.x, paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight) };
    });
    expect(Math.abs(geometry.paddingLeft - geometry.paddingRight), JSON.stringify(geometry)).toBeLessThanOrEqual(1);
    if (width === 1440) expect(Math.abs(geometry.labelX - geometry.titleX), JSON.stringify(geometry)).toBeLessThanOrEqual(2);
  });
}
