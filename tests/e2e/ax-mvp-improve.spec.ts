import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture } from "../fixtures/ax";

test("AX 1차 MVP 개선: 업무 등록 → 결정 지점 답변 → 예시 3건 입력 → 지시문 생성", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "결정 지점 확인 (D1~D7)" })).toBeVisible();

  // 2. 결정 지점 답변: D4·D5 확정 (나머지는 미확정 기본값 유지)
  await page.getByLabel("D4 상태").selectOption("확정");
  await page.getByLabel("D4 상세").fill("정상, 오류(확정), 확인 필요");
  await page.getByLabel("D5 상태").selectOption("확정");
  await page.getByLabel("D5 상세").fill("확인 필요");
  await page.getByRole("button", { name: "결정 지점 저장", exact: true }).click();
  // 저장 확인 문구는 상단 메시지와 섹션 내 문구 2곳에 나타나므로 섹션으로 한정한다.
  await expect(page.locator('section[aria-label="결정 지점 확인"]').getByText("결정 지점을 저장했습니다.", { exact: true })).toBeVisible();

  // 3. 예시 3건 입력 (정상·예외 사례 포함)
  const examples = [
    { input: "운송장 WB-001, 중량 10kg", state: "정상", value: "" },
    { input: "운송장 WB-002, 운송장번호 중복 2건", state: "오류(확정)", value: "" },
    { input: "운송장 WB-003, 도착지 빈칸", state: "확인 필요", value: "" },
  ];
  for (let k = 0; k < examples.length; k++) await page.getByRole("button", { name: "예시 추가", exact: true }).click();
  for (const [i, example] of examples.entries()) {
    await page.getByLabel(`예시 ${i + 1} 입력값`).fill(example.input);
    await page.getByLabel(`예시 ${i + 1} 기대 결과 상태`).fill(example.state);
  }
  // D4가 확정된 뒤에는 D4 목록에 없는 기대 결과의 저장을 막는다.
  const exampleSection = page.locator('section[aria-label="업무 처리 예시"]');
  await page.getByLabel("예시 1 기대 결과 상태").fill("실패");
  await page.getByRole("button", { name: "업무 처리 예시 저장", exact: true }).click();
  await expect(exampleSection.getByRole("alert")).toContainText("예시 1의 기대 결과가 D4 결과 상태 목록(정상 · 오류(확정) · 확인 필요)에 없습니다.");
  await expect(exampleSection.getByText("예시 결과를 저장했습니다.", { exact: true })).toHaveCount(0);
  await page.getByLabel("예시 1 기대 결과 상태").fill(examples[0].state);
  await page.getByRole("button", { name: "업무 처리 예시 저장", exact: true }).click();
  await expect(page.locator('section[aria-label="업무 처리 예시"]').getByText("업무 처리 예시를 저장했습니다.", { exact: true })).toBeVisible();

  // 저장 확인: IndexedDB 레코드에 결정 지점·예시 결과가 들어간다.
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
    return (task?.exampleResults as unknown[] | undefined)?.length === 3
      && points?.find(point => point.id === "D4")?.detail === "정상, 오류(확정), 확인 필요";
  }, { timeout: 10_000 }).toBe(true);
  const record = await readRecord();
  const tasks = record?.tasks as Array<Record<string, unknown>> | undefined;
  expect(tasks?.[0]?.exampleResults).toHaveLength(3);
  const points = tasks?.[0]?.diagnosis as Record<string, unknown> | undefined;
  const decisionPoints = points?.decisionPoints as Array<Record<string, unknown>> | undefined;
  expect(decisionPoints?.find(point => point.id === "D4")).toMatchObject({ status: "확정", detail: "정상, 오류(확정), 확인 필요" });

  // 4. 지시문 생성: Codex 계획 생성 후 올인원 지시문에 결정 지점·예시가 반영된다.
  await page.getByRole("tab", { name: "결과·로드맵" }).click();
  await page.getByRole("button", { name: "Codex용 구현 계획 생성", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codex용 올인원 지시문 복사", exact: true })).toBeVisible();
  const prompt = await page.locator(".ax-prompt").textContent();
  expect(prompt).toContain("결과 상태 목록: 정상 · 오류(확정) · 확인 필요");
  expect(prompt).toContain("### 결정 지점·예시 기반 구현 순서");
  expect(prompt).toContain("### 미확정 항목 처리");
  expect(prompt).toContain("미확정 규칙에 해당하는 행만 '확인 필요'로 보내고");
  expect(prompt).toContain("| 입력 값 | 기대 결과 | 메모 |");
  expect(prompt).toContain("운송장 WB-001, 중량 10kg");
  expect(prompt).toContain("예시별 기대 결과, 실제 결과, 일치 여부");
});
