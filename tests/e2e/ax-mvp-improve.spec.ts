import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture } from "../fixtures/ax";
import { addInlineRule, chooseOption } from "./ax-rules";

test("AX 1차 MVP 개선: 업무 등록 → 결정 지점 답변 → 범용 규칙 추가 → 지시문 생성", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
  await page.goto("/");
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();

  // 1. 업무 등록
  await page.getByLabel("업무명", { exact: true }).fill("운송장 검증");
  await page.getByLabel("업무 설명", { exact: true }).fill("운송장 데이터를 입력받아 누락·중복을 검사하고 검증 결과를 출력한다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByRole("button", { name: "업무 진단 실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "업무 규칙 확인" })).toBeVisible();

  // 2. 결정 지점 답변: D4·D5 확정 (나머지는 도출 후보 미확정 유지)
  // 아코디언 행을 펼쳐야 내부 입력이 보인다.
  await page.getByRole("button", { name: /D4 결과 상태/ }).click();
  await chooseOption(page.locator("#ax-decision-D4"), "상태", "확정");
  await page.locator("#ax-decision-D4").getByLabel("대조 기준").fill("정상, 오류(확정), 확인 필요");
  await page.getByRole("button", { name: /D5 판단 불가 처리/ }).click();
  await chooseOption(page.locator("#ax-decision-D5"), "상태", "확정");
  // D4 확정 후 D5 상세는 D4 목록 선택형으로 표시된다.
  await chooseOption(page.locator("#ax-decision-D5"), "대조 기준", "확인 필요");
  await page.locator('section[aria-label="업무 규칙 확인"]').getByRole("button", { name: "저장", exact: true }).click();
  // 저장 확인 문구는 상단 메시지와 섹션 내 문구 2곳에 나타나므로 섹션으로 한정한다.
  await expect(page.locator('section[aria-label="업무 규칙 확인"]').getByText("업무 규칙을 저장했습니다.", { exact: true })).toBeVisible();
  // 도출 후보 분모: D4·D5 확정 2건 / D3·D4·D5·D6 4건 + 범용 후보 적용 여부 확인 2건.
  await expect(page.locator('section[aria-label="업무 규칙 확인"]').getByText("2/4 완료 · 적용 확인 2건", { exact: true })).toBeVisible();

  // 3. 범용 규칙 1건 추가: 목록 맨 아래 인라인 신규 항목에서 적용·확정으로 작성해 목록에 추가한다.
  const unified = page.locator('section[aria-label="업무 규칙 확인"]');
  await addInlineRule(unified, { name: "월말 마감 이후 주문 이월", detail: "마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.", category: "처리·판단 기준", applicability: "적용", status: "확정" });
  await unified.getByRole("button", { name: "저장", exact: true }).click();
  await expect(unified.getByText("업무 규칙을 저장했습니다.", { exact: true })).toBeVisible();
  await expect(page.locator('section[aria-label="업무 규칙 확인"]').getByText("3/5 완료 · 적용 확인 2건", { exact: true })).toBeVisible();

  // D4 변경 후에도 범용 규칙은 그대로 유지된다.
  await page.getByRole("button", { name: /D4 결과 상태/ }).click();
  await page.locator("#ax-decision-D4").getByLabel("대조 기준").fill("정상, 확인 필요");
  await page.locator('section[aria-label="업무 규칙 확인"]').getByRole("button", { name: "저장", exact: true }).click();

  // 저장 확인: IndexedDB 레코드에 결정 지점·범용 규칙이 들어간다.
  // useAxState 저장은 디바운스되므로 플러시될 때까지 poll한다.
  const readRecord = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open("worklens-ax", 1); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise<Record<string, unknown> | undefined>(resolve => { const req = db.transaction("state", "readonly").objectStore("state").get("current"); req.onsuccess = () => resolve(req.result); });
    db.close();
    return value;
  });
  await expect.poll(async () => {
    const value = await readRecord();
    const task = (value?.tasks as Array<Record<string, unknown>> | undefined)?.[0];
    const points = (task?.diagnosis as Record<string, unknown> | undefined)?.decisionPoints as Array<Record<string, unknown>> | undefined;
    const rules = task?.genericRules as Array<Record<string, unknown>> | undefined;
    return rules?.length === 1
      && rules?.[0]?.name === "월말 마감 이후 주문 이월"
      && points?.find(point => point.id === "D4")?.detail === "정상, 확인 필요";
  }, { timeout: 10_000 }).toBe(true);
  const record = await readRecord();
  const tasks = record?.tasks as Array<Record<string, unknown>> | undefined;
  expect(tasks?.[0]?.genericRules).toHaveLength(1);
  const points = tasks?.[0]?.diagnosis as Record<string, unknown> | undefined;
  const decisionPoints = points?.decisionPoints as Array<Record<string, unknown>> | undefined;
  expect(decisionPoints?.find(point => point.id === "D4")).toMatchObject({ status: "확정", detail: "정상, 확인 필요" });
  expect((tasks?.[0]?.genericRules as Array<Record<string, unknown>>)?.[0]).toMatchObject({ name: "월말 마감 이후 주문 이월", status: "확정" });

  // 4. 지시문 생성: Codex 계획 생성 후 올인원 지시문에 결정 지점·범용 규칙이 반영된다.
  await page.getByRole("tab", { name: "결과·로드맵" }).click();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  const prompt = await page.locator(".ax-prompt").textContent();
  expect(prompt).toContain("결과 상태 목록: 정상 · 확인 필요");
  expect(prompt).toContain("### 결정 지점·업무 규칙 기반 구현 순서");
  expect(prompt).toContain("### 미확정 항목 처리");
  expect(prompt).toContain("미확정 규칙에 해당하는 행만 '확인 필요'로 보내고");
  expect(prompt).toContain("### 업무 규칙 (범용)");
  expect(prompt).toContain("R1 월말 마감 이후 주문 이월");
  expect(prompt).toContain("마감일 이후 접수 주문은 다음 달 집계 대상에 포함하지 않는다.");
  expect(prompt).toContain("### 업무 규칙 검증");
  expect(prompt).toContain("확정 규칙별 처리 결과, 실제 결과, 일치 여부");
  expect(prompt).not.toContain("### 확정 예시");
  expect(prompt).not.toContain("| 입력 값 | 기대 결과 | 메모 |");
});
