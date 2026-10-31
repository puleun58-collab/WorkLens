import { expect, type Locator } from "@playwright/test";

/** 업무 규칙 확인의 COSS 선택창(combobox)에서 항목을 고른다. */
export async function chooseOption(scope: Locator, label: string | RegExp, option: string) {
  const trigger = scope.getByRole("combobox", { name: label });
  await trigger.click();
  await scope.page().getByRole("option", { name: option, exact: true }).click();
  await expect(trigger).toContainText(option);
}

/** "+ 규칙 추가"로 목록 맨 아래 인라인 신규 항목을 열고 규칙 이름·분류·업무 적용 여부·처리 기준·확정 상태를
 * 채워 "목록에 추가"한다. applicability "적용 여부 미확정"은 선택 전 그대로 둔다. */
export async function addInlineRule(unified: Locator, rule: { name: string; category: string; applicability: "적용" | "해당 없음" | "적용 여부 미확정"; status: string; detail?: string }) {
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const row = unified.locator("#ax-rule-new");
  await expect(row).toBeVisible();
  await row.getByLabel("규칙 이름").fill(rule.name);
  await chooseOption(row, "규칙 분류", rule.category);
  if (rule.applicability !== "적용 여부 미확정") await chooseOption(row, "업무 적용 여부", rule.applicability === "적용" ? "적용" : "미적용");
  if (rule.detail !== undefined) await row.getByLabel("처리 기준").fill(rule.detail);
  if (rule.applicability !== "해당 없음") await chooseOption(row, "확정 상태", rule.status);
  await row.getByRole("button", { name: "목록에 추가", exact: true }).click();
  await expect(row).toHaveCount(0);
}
