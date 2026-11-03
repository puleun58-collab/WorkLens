import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";

/** 업무 규칙 확인의 COSS 선택창(combobox)에서 항목을 고른다. */
export async function chooseOption(scope: Locator, label: string | RegExp, option: string) {
  const trigger = scope.getByRole("combobox", { name: label });
  await trigger.click();
  await scope.page().getByRole("option", { name: option, exact: true }).click();
  await expect(trigger).toContainText(option);
}

/** 인라인 규칙을 추가한다. 적용한 규칙만 추가 기준(선택)을 작성하고 버튼으로 확정한다.
 * 적용 여부 미확정은 미선택("선택하세요") 그대로 둔다. */
export async function addInlineRule(unified: Locator, rule: { name: string; category: string; applicability: "적용" | "해당 없음" | "적용 여부 미확정"; status: string; detail?: string }) {
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const row = unified.locator("#ax-rule-new");
  await expect(row).toBeVisible();
  await row.getByLabel("규칙명").fill(rule.name);
  await chooseOption(row, "분류", rule.category);
  if (rule.applicability !== "적용 여부 미확정") await chooseOption(row, "적용 여부", rule.applicability === "적용" ? "적용" : "미적용");
  if (rule.applicability === "적용" && rule.detail !== undefined) await row.getByLabel("추가 기준 (선택)").fill(rule.detail);
  if (rule.applicability === "적용" && rule.status === "확정") await row.getByRole("button", { name: "확정", exact: true }).click();
  await row.getByRole("button", { name: "추가", exact: true }).click();
  await expect(row).toHaveCount(0);
}
