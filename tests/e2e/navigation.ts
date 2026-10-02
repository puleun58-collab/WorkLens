import { expect, type Page } from "@playwright/test";

/**
 * Opens a workspace view the way a user can at the current width: the
 * sidebar on desktop, the menu sheet at 900px and below.
 */
export async function navigateWorkspace(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "작업 공간 메뉴 열기", exact: true });
  const mobile = await menu.isVisible();
  if (mobile) await menu.click();
  await page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true })
    .getByRole("button", { name, exact: true }).click();
  if (mobile) await expect(page.getByRole("dialog")).not.toBeVisible();
}
