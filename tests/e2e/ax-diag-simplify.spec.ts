import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture } from "../fixtures/ax";

async function registerAndDiagnose(page: import("@playwright/test").Page, name: string, description: string) {
  await page.route("**/api/ai", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
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
  await expect(decision.getByText("0/7 확인 완료", { exact: true })).toBeVisible();

  // 기본은 모두 접힘이므로 D1 행을 펼쳐 입력한다. D2를 펼치면 D1이 접히고,
  // 다시 D1을 펼쳐도 미저장 입력이 유지된다.
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await page.locator("#ax-decision-D1").getByLabel("상태").selectOption("확정");
  await page.locator("#ax-decision-D1").getByLabel("대조 기준").fill("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
  await expect(decision.locator(".ax-decision-counter")).toContainText("/ 2000");
  await page.getByRole("button", { name: /D2 중복 처리/ }).click();
  await expect(page.locator("#ax-decision-D1").getByLabel("대조 기준")).toBeHidden();
  await expect(page.locator("#ax-decision-D2").getByLabel("상태")).toBeVisible();
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await expect(page.locator("#ax-decision-D1").getByLabel("대조 기준")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");

  // 해당 없음이면 상세 입력이 숨겨지고, 되돌리면 다시 보인다.
  await page.getByRole("button", { name: /D3 예외값 처리/ }).click();
  await page.locator("#ax-decision-D3").getByLabel("상태").selectOption("해당 없음");
  await expect(page.locator("#ax-decision-D3").getByLabel("대조 기준")).toHaveCount(0);
  await page.locator("#ax-decision-D3").getByLabel("상태").selectOption("미확정");
  await expect(page.locator("#ax-decision-D3").getByLabel("대조 기준")).toBeVisible();

  // 저장 후 진행률 갱신 + 저장 플러시 확인 후 새로고침 후 재조회.
  await decision.getByRole("button", { name: "저장", exact: true }).click();
  await expect(decision.getByText("결정 지점을 저장했습니다.", { exact: true })).toBeVisible();
  await expect(decision.getByText("1/7 확인 완료", { exact: true })).toBeVisible();
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
    return points?.find(point => point.id === "D1")?.status === "확정";
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  // 새로고침하면 셸 뷰가 기본값(문서 분석)으로 돌아가므로 AX 화면으로 다시 이동한다 (기존 reload 패턴과 동일).
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await expect(page.locator("#ax-decision-D1").getByLabel("상태")).toHaveValue("확정");
  await expect(page.locator("#ax-decision-D1").getByLabel("대조 기준")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
});

test("AX 진단 간소화: 범용 규칙 아코디언 초안 유지·삭제·저장", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const generic = page.locator('section[aria-label="범용 업무 규칙"]');
  await expect(generic.getByText("등록된 범용 규칙이 없습니다.")).toBeVisible();
  await generic.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  await generic.getByLabel("규칙명").fill("규칙 A");
  await generic.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  await generic.getByLabel("규칙명").fill("규칙 B");
  // 행을 접었다 펼쳐도 작성 중인 입력값이 사라지지 않는다.
  await generic.getByRole("button", { name: /R1 규칙 A/ }).click();
  await expect(generic.getByLabel("규칙명")).toHaveValue("규칙 A");
  await generic.getByRole("button", { name: /R2 규칙 B/ }).click();
  await expect(generic.getByLabel("규칙명")).toHaveValue("규칙 B");
  // 규칙 1 삭제 후 남은 규칙은 R2로 유지되고 규칙 B를 유지한다 (id 재부여 없음).
  await generic.getByRole("button", { name: /R1 규칙 A/ }).click();
  await generic.getByRole("button", { name: "이 규칙 삭제" }).click();
  await expect(generic.getByText("규칙 A")).toHaveCount(0);
  await expect(generic.getByText("규칙 B")).toBeVisible();
  await generic.getByRole("button", { name: "저장", exact: true }).click();
  await expect(generic.getByText("범용 업무 규칙을 저장했습니다.", { exact: true })).toBeVisible();
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
    return rules?.length === 1 && rules?.[0]?.name === "규칙 B";
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  // 새로고침하면 셸 뷰가 기본값(문서 분석)으로 돌아가므로 AX 화면으로 다시 이동한다 (기존 reload 패턴과 동일).
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();
  await expect(page.locator('section[aria-label="범용 업무 규칙"]').getByText("규칙 B")).toBeVisible();
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

test("AX 진단 간소화: 모바일 390에서 범용 규칙 2열이 1열로 전환되고 가로 넘침이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const generic = page.locator('section[aria-label="범용 업무 규칙"]');
  await generic.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const panel = page.locator(".ax-generic-panel");
  await expect(panel).toBeVisible();
  const tracks = await panel.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(tracks).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
