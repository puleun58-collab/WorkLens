import { expect, type Locator } from "@playwright/test";

/** 업무 규칙 확인의 COSS 선택창(combobox)에서 항목을 고른다. */
export async function chooseOption(scope: Locator, label: string | RegExp, option: string) {
  const trigger = scope.getByRole("combobox", { name: label });
  await trigger.click();
  await scope.page().getByRole("option", { name: option, exact: true }).click();
  await expect(trigger).toContainText(option);
}

/** "+ 규칙 추가"로 목록 맨 아래 인라인 신규 항목을 열고 기본 4개 항목·분류를 채워 "목록에 추가"한다. */
export async function addInlineRule(unified: Locator, rule: { name: string; category: string; applicability: string; status: string; detail?: string }) {
  await unified.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const row = unified.locator("#ax-rule-new");
  await expect(row).toBeVisible();
  await row.getByLabel("규칙명").fill(rule.name);
  await chooseOption(row, "이 규칙을 업무에 적용하나요?", rule.applicability);
  if (rule.detail !== undefined) await row.getByLabel("실제 처리 규칙").fill(rule.detail);
  if (rule.applicability !== "해당 없음") await chooseOption(row, "규칙 확정 여부", rule.status);
  await row.getByRole("button", { name: "상세 설정" }).click();
  await chooseOption(row, "분류", rule.category);
  await row.getByRole("button", { name: "목록에 추가", exact: true }).click();
  await expect(row).toHaveCount(0);
}
