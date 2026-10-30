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
  await expect(page.getByRole("heading", { name: "결정 지점 확인 (D1~D7)" })).toBeVisible();
}

test("AX 진단 간소화: D1~D7 아코디언 단일 펼침·진행률·저장·재조회", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const decision = page.locator('section[aria-label="결정 지점 확인"]');
  await expect(decision.getByText("0/7 완료", { exact: true })).toBeVisible();

  // 기본은 모두 접힘이므로 D1 행을 펼쳐 입력한다. D2를 펼치면 D1이 접히고,
  // 다시 D1을 펼쳐도 미저장 입력이 유지된다.
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await page.getByLabel("대조 기준 (D1) 상태").selectOption("확정");
  await page.getByLabel("대조 기준 (D1) 상세").fill("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
  await page.getByRole("button", { name: /D2 중복 처리/ }).click();
  await expect(page.getByLabel("대조 기준 (D1) 상세")).toBeHidden();
  await expect(page.getByLabel("중복 처리 (D2) 상태")).toBeVisible();
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await expect(page.getByLabel("대조 기준 (D1) 상세")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");

  // 해당 없음이면 상세 입력이 숨겨지고, 되돌리면 다시 보인다.
  await page.getByRole("button", { name: /D3 예외값 처리/ }).click();
  await page.getByLabel("예외값 처리 (D3) 상태").selectOption("해당 없음");
  await expect(page.getByLabel("예외값 처리 (D3) 상세")).toHaveCount(0);
  await page.getByLabel("예외값 처리 (D3) 상태").selectOption("미확정");
  await expect(page.getByLabel("예외값 처리 (D3) 상세")).toBeVisible();

  // 저장 후 진행률 갱신 + 저장 플러시 확인 후 새로고침 후 재조회.
  await decision.getByRole("button", { name: "저장", exact: true }).click();
  await expect(decision.getByText("결정 지점을 저장했습니다.", { exact: true })).toBeVisible();
  await expect(decision.getByText("1/7 완료", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "결정 지점 확인 (D1~D7)" })).toBeVisible();
  await page.getByRole("button", { name: /D1 대조 기준/ }).click();
  await expect(page.getByLabel("대조 기준 (D1) 상태")).toHaveValue("확정");
  await expect(page.getByLabel("대조 기준 (D1) 상세")).toHaveValue("판매내역.xlsx / Sheet1, 주문번호, 누락·초과 판단");
});

test("AX 진단 간소화: 업무 처리 예시 탭 전환 시 초안 유지·삭제·저장", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  const examples = page.locator('section[aria-label="업무 처리 예시"]');
  await page.getByRole("button", { name: "+ 새 예시", exact: true }).click();
  await page.getByLabel("예시 1 입력값").fill("입력 A");
  await page.getByRole("button", { name: "+ 새 예시", exact: true }).click();
  await page.getByLabel("예시 2 입력값").fill("입력 B");
  // 탭을 바꿔도 작성 중인 입력값이 사라지지 않는다.
  await page.getByRole("tab", { name: "예시 1", exact: true }).click();
  await expect(page.getByLabel("예시 1 입력값")).toHaveValue("입력 A");
  // 예시 1 삭제 후 남은 탭은 예시 1로 renumber되고 입력 B를 유지한다.
  await page.getByRole("button", { name: "예시 1 삭제", exact: true }).click();
  await expect(examples.getByRole("tab", { name: "예시 2", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("예시 1 입력값")).toHaveValue("입력 B");
  await page.getByLabel("예시 1 예상 결과 상태").fill("정상");
  await examples.getByRole("button", { name: "저장", exact: true }).click();
  await expect(examples.getByText("업무 처리 예시를 저장했습니다.", { exact: true })).toBeVisible();
  // useAxState 저장은 디바운스되므로 플러시될 때까지 poll한 뒤 새로고침한다 (즉시 새로고침하면 저장 전 상태로 복원된다).
  await expect.poll(async () => {
    const value = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
      const record = await new Promise<Record<string, unknown> | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
      db.close();
      return record;
    });
    const task = (value?.tasks as Array<Record<string, unknown>> | undefined)?.[0];
    const results = task?.exampleResults as Array<Record<string, unknown>> | undefined;
    return results?.length === 1 && results?.[0]?.input === "입력 B";
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  // 새로고침하면 셸 뷰가 기본값(문서 분석)으로 돌아가므로 AX 화면으로 다시 이동한다 (기존 reload 패턴과 동일).
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "결정 지점 확인 (D1~D7)" })).toBeVisible();
  await expect(page.getByLabel("예시 1 입력값")).toHaveValue("입력 B");
});

test("AX 진단 간소화: 매트릭스 상세 중복 제거·단일 점수 근거·업무 전환 갱신", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerAndDiagnose(page, "업무 A", "업무 A 설명: 반복 입력 자료를 취합해 결과를 출력한다.");
  await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
  await page.getByLabel("업무명", { exact: true }).fill("업무 B");
  await page.getByLabel("업무 설명", { exact: true }).fill("업무 B 설명: 반복 입력 자료를 취합해 결과를 출력한다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await page.getByRole("tab", { name: "자동화 매트릭스", exact: true }).click();

  const detail = page.locator(".ax-matrix-detail");
  await expect(detail.getByRole("heading").first()).toContainText("업무 B");
  // 제거된 3개 영역이 상세 카드에 없다 (데이터·판정 로직은 유지).
  await expect(detail.getByText("핵심 판단 근거")).toHaveCount(0);
  await expect(detail.getByText("현재 가능한 범위")).toHaveCount(0);
  await expect(detail.getByText("선행 확인 조건")).toHaveCount(0);
  // 점수 근거 확인 한 번으로 6개 Factor 근거가 모두 보이고, 중첩 토글이 없다.
  const evidence = detail.getByRole("button", { name: "점수 근거 확인", exact: true });
  await evidence.click();
  await expect(detail.locator(".ax-score-factor")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "평가 근거 자세히 보기", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "평가 근거 접기", exact: true })).toHaveCount(0);
  await evidence.click();
  await expect(evidence).toHaveAttribute("aria-expanded", "false");
  // 다른 업무 선택 시 상세와 점수가 해당 업무로 갱신된다.
  await page.getByLabel("매트릭스 업무 목록").getByRole("button", { name: /업무 A/ }).click();
  await expect(detail.getByRole("heading").first()).toContainText("업무 A");
  await detail.getByRole("button", { name: "점수 근거 확인", exact: true }).click();
  await expect(detail.locator(".ax-score-factor")).toHaveCount(6);

  // 진단 단계: AS-IS 도식 제거, 단계별 판단 표가 단일 목록이다.
  await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
  await expect(page.locator(".ax-process-flow")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "단계별 자동화 판단", exact: true })).toBeVisible();
});

test("AX 진단 간소화: 모바일 390에서 예시 2열이 1열로 전환되고 가로 넘침이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAndDiagnose(page, "운송장 검증", "운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  await page.getByRole("button", { name: "+ 새 예시", exact: true }).click();
  const cols = page.locator(".ax-example-col");
  await expect(cols).toHaveCount(2);
  const boxes = await cols.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
  expect(boxes[1]).toBeGreaterThan(boxes[0]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
