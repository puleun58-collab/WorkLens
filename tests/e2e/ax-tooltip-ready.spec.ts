import { expect, test, type Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { outputFixture, planFixture } from "../fixtures/ax";
import { waitForFactorControlReady } from "./ax-ready-state";

async function ax(page: Page) {
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(page.getByRole("heading", { name: "업무 자동화 진단", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "진단 단계" })).toBeVisible();
}
async function register(page: Page, name = "월간 취합") {
  await page.getByLabel("업무명", { exact: true }).fill(name);
  await page.getByLabel("업무 설명", { exact: true }).fill("매월 입력 표를 취합하고 담당자가 최종 승인합니다.");
  await page.getByRole("button", { name: "업무 등록", exact: true }).click();
}
function mock(page: Page) {
  return page.route("**/api/ai", async route => {
    const req = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: req.kind === "ax-plan" ? { kind: "ax-plan", plan: planFixture } : { kind: "ax-diagnosis", diagnosis: outputFixture() } }) });
  });
}

// L167 툴팁 단언을 ax.spec 긴 스펙에서 분리한 짧은 테스트이다. 단언은 긴 스펙과
// 같은 문구·같은 엄격도를 유지한다. 보정 완료 상태나 reset 존재를 미리 seed하지
// 않고, 실제 보정 클릭 뒤 새로 마운트된 reset에 바로 hover한다. 빠른 전환 중
// 조작 경로는 이 테스트가 검증하지 않으며, 펼침 완료를 기다리는 준비 상태 대기는
// 실패 조건 제거이지 빠른 조작 결함 해결이 아니다.
test("AX reset tooltip shows after detail expand settles", async ({ page }) => {
  await mock(page);
  await page.goto("/"); await ax(page); await register(page);
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.route("**/api/ai", async route => { await page.waitForTimeout(800); await route.fallback(); }, { times: 1 });
  await page.getByRole("button", { name: "업무 진단 실행" }).click();
  await expect(page.getByText("정보 충분", { exact: true })).toBeVisible();
  await expect(page.locator(".ax-data-actions .ax-utility-message")).toHaveText("업무 진단을 완료했습니다. 필요한 경우 점수를 조정하세요.");
  await page.getByRole("button", { name: /진단 항목 상세/ }).click();
  const factor = page.getByRole("button", { name: "반복성 1점", exact: true });
  await waitForFactorControlReady(factor);
  await factor.click();
  await expect(page.getByText("사용자 보정 완료", { exact: true }).last()).toBeVisible();
  const reset = page.getByRole("button", { name: "AI 제안값으로 되돌리기", exact: true });
  await expect(page.getByRole("button", { name: "AI 값으로", exact: true })).toHaveCount(0);
  await expect(reset).toHaveCount(1); await expect(reset).toBeEnabled();
  await expect(reset.locator("svg.lucide-rotate-ccw")).toHaveCount(1);
  // 부드러운 스크롤이 진행 중인 좌표로 hover하면 배지가 FAB 아래로 이동할 수 있다.
  // 즉시 중앙 정렬한 뒤 실제 위치가 안전한지 확인하고 hover한다.
  await reset.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await expect.poll(async () => {
    const box = await reset.boundingBox();
    return box ? box.y + box.height / 2 : 1000;
  }).toBeLessThan(700);
  await reset.hover();
  await expect(page.getByRole("tooltip").or(page.locator('[data-slot="tooltip-popup"]')).first()).toContainText("AI 제안값으로 되돌리기");
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-slot="tooltip-popup"]', { hasText: "AI 제안값으로 되돌리기" })).toHaveCount(0);
});
