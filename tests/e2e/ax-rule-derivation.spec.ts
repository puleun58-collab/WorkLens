import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { navigateWorkspace } from "./navigation";
import { excelComparisonFixture, facilitySafetyFixture, scheduleNotificationFixture } from "../fixtures/ax-rule-derivation";
import { taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";
import { DECISION_DETAIL_FIELD, decisionPanelLabel } from "../../src/lib/ax/rule-questions";
import { chooseOption } from "./ax-rules";

async function seed(page: Page, record: unknown) {
  await page.evaluate(async value => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("worklens-ax", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, record);
}

async function measureAlignment(row: Locator, width: number, label: string, hasBadge = true) {
  // The visible grey input edge is the COSS wrapper's border; the native textarea is inset 1px.
  const control = await row.locator('[data-slot="textarea-control"]').boundingBox();
  const textarea = await row.locator("textarea").boundingBox();
  const edge = await row.locator(hasBadge ? ".ax-decision-badge" : ".ax-decision-row-summary").boundingBox();
  const confirm = row.locator(".ax-rule-confirm button");
  const button = await confirm.count() ? await confirm.boundingBox() : null;
  const panel = await row.locator(".ax-decision-panel, .ax-generic-panel").boundingBox();
  expect(control).not.toBeNull();
  expect(textarea).not.toBeNull();
  expect(edge).not.toBeNull();
  expect(panel).not.toBeNull();
  const result = {
    width, label,
    badgeRight: hasBadge ? edge!.x + edge!.width : null,
    headerContentRight: edge!.x + edge!.width,
    inputRight: control!.x + control!.width,
    nativeTextareaRight: textarea!.x + textarea!.width,
    buttonRight: button ? button.x + button.width : null,
    inputLeft: control!.x, panelLeft: panel!.x,
  };
  expect(Math.abs(result.inputRight - result.headerContentRight)).toBeLessThanOrEqual(0.1);
  if (result.buttonRight !== null) expect(Math.abs(result.inputRight - result.buttonRight)).toBeLessThanOrEqual(0.1);
  expect(result.inputLeft - result.panelLeft).toBe(width <= 700 ? 14 : 62);
  const styles = await row.locator("textarea").evaluate(element => {
    const style = getComputedStyle(element);
    return { minHeight: style.minHeight, padding: style.padding };
  });
  expect(styles).toEqual({ minHeight: "96px", padding: "10px 12px" });
  const selectWidth = (await row.getByRole("combobox").first().boundingBox())!.width;
  if (width > 700) expect(selectWidth).toBe(360);
  else expect(selectWidth).toBe(panel!.width - 28);
  console.log(`RULE_ALIGNMENT ${JSON.stringify(result)}`);
  return result;
}

for (const width of [1440, 390]) test(`규칙 입력창·배지·확정 버튼 오른쪽 정렬 D1~D7·제안·저장·신규 ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const ids = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;
  const task = {
    ...taskFixture("rule-alignment", {
      ...excelComparisonFixture.diagnosis,
      decisionPoints: ids.map(id => ({ id, status: "미확정" as const, detail: `기존 ${id} 사용자 기준` })),
    }),
    genericRules: [{ id: "R1", name: "기존 저장 규칙", category: "처리·판단 기준" as const, applicability: "적용" as const, status: "확정" as const, detail: "기존 사용자 입력" }],
  };
  await page.goto("/");
  await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
  const measurements = [];
  for (const id of ids) {
    const row = section.locator(`#ax-decision-${id}`);
    await row.locator(".ax-decision-row-head").click();
    await expect(row.getByRole("textbox", { name: decisionPanelLabel(id, "상세"), exact: true })).toHaveAttribute("placeholder", DECISION_DETAIL_FIELD[id].placeholder);
    measurements.push(await measureAlignment(row, width, id));
  }
  const candidate = section.locator(".ax-decision-row").filter({ has: page.locator(".ax-decision-no-new", { hasText: "제안" }) }).first();
  await candidate.locator(".ax-decision-row-head").click();
  await chooseOption(candidate, "적용 여부", "적용");
  measurements.push(await measureAlignment(candidate, width, "제안-확정"));
  await candidate.getByRole("button", { name: "확정", exact: true }).click();
  measurements.push(await measureAlignment(candidate, width, "제안-확정취소"));
  const stored = section.locator("#ax-rule-R1");
  await stored.locator(".ax-decision-row-head").click();
  await expect(stored.getByRole("textbox", { name: "추가 기준 (선택)", exact: true })).toHaveValue("기존 사용자 입력");
  measurements.push(await measureAlignment(stored, width, "저장"));

  await section.getByRole("button", { name: "+ 규칙 추가", exact: true }).click();
  const newRow = section.locator("#ax-rule-new");
  await newRow.getByLabel("규칙명", { exact: true }).fill("정렬 확인 신규 규칙");
  await chooseOption(newRow, "분류", "처리·판단 기준");
  await chooseOption(newRow, "적용 여부", "적용");
  measurements.push(await measureAlignment(newRow, width, "신규-작성중", false));
  await newRow.getByRole("button", { name: "확정", exact: true }).click();
  await newRow.getByRole("button", { name: "추가", exact: true }).click();
  const added = section.locator(".ax-decision-row").filter({ has: page.locator(".ax-decision-title strong", { hasText: "정렬 확인 신규 규칙" }) });
  measurements.push(await measureAlignment(added, width, "신규-추가후"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await testInfo.attach(`rule-alignment-${width}`, { body: JSON.stringify({ measurements, overflow }, null, 2), contentType: "application/json" });
});

for (const fixture of [excelComparisonFixture, facilitySafetyFixture, scheduleNotificationFixture]) {
  for (const width of [1440, 390]) {
    test(`업무별 규칙 제안 ${fixture.id} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const task = { ...taskFixture(`rules-${fixture.id}`, fixture.diagnosis), name: fixture.label };
      await page.goto("/");
      await seed(page, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 2 });
      await navigateWorkspace(page, "업무 자동화 진단");
      const section = page.getByRole("region", { name: "업무 규칙 확인", exact: true });
      await expect(section).toBeVisible();
      for (const id of fixture.expectedDecisionIds) {
        const row = section.locator(`#ax-decision-${id}`);
        await expect(row).toBeVisible();
        await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
        await expect(row.getByText("제안", { exact: true })).toHaveCount(0);
      }
      for (const id of fixture.excludedDecisionIds) await expect(section.locator(`#ax-decision-${id}`)).toHaveCount(0);
      const cards = section.locator(".ax-decision-row");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      await expect(section.getByText(`0/${count} 완료`, { exact: true })).toBeVisible();
      const genericCards = cards.filter({ has: page.locator(".ax-decision-no-new") });
      const genericCount = await genericCards.count();
      expect(count).toBe(fixture.expectedDecisionIds.length + genericCount);
      const genericContents: string[] = [];
      for (let index = 0; index < genericCount; index++) {
        const row = genericCards.nth(index);
        await expect(row.getByText("제안", { exact: true })).toBeVisible();
        await expect(row.locator(".ax-decision-badge")).toHaveText("미확정");
        await row.locator(".ax-decision-row-head").click();
        await expect(row.getByRole("combobox", { name: "적용 여부", exact: true })).toHaveText("선택하세요");
        genericContents.push(await row.locator(".ax-decision-title strong").innerText());
      }
      for (const terms of fixture.requiredGenericRules) {
        expect(genericContents.some(content => terms.every(term => content.includes(term)))).toBe(true);
      }
      for (const text of fixture.excludedGenericRules) {
        expect(genericContents.some(content => content.includes(text))).toBe(false);
      }
      await expect(section.getByText("신규", { exact: true })).toHaveCount(0);
      await expect(section).not.toContainText("이메일 API 제공 여부 확인");
      const bounds = await section.evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: window.innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport);
      await section.screenshot({
        path: `artifacts/rules/${fixture.id}-${width}.png`,
        animations: "disabled",
        style: ".utility-bar, .skip-link, .wl-assistant-root { visibility: hidden !important; }",
      });
      await section.getByRole("button", { name: "저장", exact: true }).click();
      await expect(section.getByText("업무 규칙을 저장했습니다", { exact: true })).toBeVisible();
      const persisted = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("worklens-ax", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const result = await new Promise<{ tasks: { diagnosis?: { decisionPoints?: unknown[] }; genericRules?: unknown[] }[] }>((resolve, reject) => {
          const request = db.transaction("state").objectStore("state").get("current");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return result.tasks[0];
      });
      expect(persisted.diagnosis?.decisionPoints ?? []).toEqual([]);
      expect(persisted.genericRules ?? []).toEqual([]);
      await expect(section.getByText(`0/${count} 완료`, { exact: true })).toBeVisible();
    });
  }
}
