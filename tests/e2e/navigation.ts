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
  await page.getByRole("navigation", { name: "작업 공간 메뉴", exact: true })
    .getByRole("button", { name, exact: true }).click();
  if (mobile) await expect(page.getByRole("dialog")).not.toBeVisible();
}
