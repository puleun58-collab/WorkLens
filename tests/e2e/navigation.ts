import { expect, type Page } from "@playwright/test";

/**
 * Opens a workspace view the way a user can at the current width: the
 * sidebar on desktop, the menu sheet at 900px and below.
 *
 * The navigation buttons are hydration-dependent onClick buttons, so a click
 * before hydration is a silent no-op that Playwright still reports as a
 * success; wait for the interactive tree first (tools.spec.ts:105 failed
 * exactly this way: the click vanished and the searchbox never appeared).
 */
export async function navigateWorkspace(page: Page, name: string) {
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  const menu = page.getByRole("button", { name: "작업 공간 메뉴 열기", exact: true });
  const mobile = await menu.isVisible();
  if (mobile) await menu.click();
  const nav = page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true });
  const target = nav.getByRole("button", { name, exact: true });
  // 용어 사전은 검수 아코디언 하위에 있어 접힌 상태에서는 클릭할 수 없으므로,
  // 보이지 않으면 먼저 하위 메뉴를 펼친다.
  if (name === "Dictionary" && !(await target.isVisible())) {
    await nav.getByRole("button", { name: "검수 하위 메뉴 펼치기", exact: true }).click();
  }
  await target.click();
  if (mobile) await expect(page.getByRole("dialog")).not.toBeVisible();
}
