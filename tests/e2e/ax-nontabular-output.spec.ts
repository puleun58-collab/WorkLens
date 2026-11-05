import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { diagnosisFixture, planFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState } from "../../src/lib/ax/types";
import { navigateWorkspace } from "./navigation";

for (const width of [1440, 390]) test(`보고서 파일에 출력 컬럼 확인을 강제하지 않는다 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  const diagnosis = { ...structuredClone(diagnosisFixture),
    asIs: { ...diagnosisFixture.asIs, outputs: ["월간보고서.txt", "메일 파일", "체크리스트 파일"] },
    poc: { ...diagnosisFixture.poc, outputs: ["월간보고서.txt", "메일 파일", "체크리스트 파일"] },
    technicalChecks: [], decisionGate: { verdict: "go" as const, reasons: [] },
    planCodex: { ...planFixture, prerequisites: [], integrations: [] },
  };
  const task = taskFixture("nontabular-output", diagnosis);
  await page.goto("/");
  await page.evaluate(async state => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("worklens-ax", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    const saved = Promise.withResolvers<void>();
    const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(state, "current");
    tx.oncomplete = () => saved.resolve(); tx.onerror = () => saved.reject(tx.error);
    await saved.promise; db.close();
  }, { ...emptyAxState(), tasks: [task], selectedTaskId: task.id, step: 4 });
  await navigateWorkspace(page, "업무 자동화 진단");
  await page.getByRole("region", { name: "올인원 지시문", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect(page.locator(".ax-prompt")).toContainText("월간보고서.txt");
  await expect(page.locator(".ax-prompt")).not.toContainText("출력 컬럼 미확정");
  await mkdir("D:/hageon/ax-recheck-shots", { recursive: true });
  await page.screenshot({ path: `D:/hageon/ax-recheck-shots/nontabular-${width}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
