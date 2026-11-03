import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { navigateWorkspace } from "./navigation";
import { diagnosisFixture, outputFixture, taskFixture } from "../fixtures/ax";
import { emptyAxState, type AxStateV2, type AxTaskV2 } from "../../src/lib/ax/types";
import { extractReviewableItems } from "../../src/lib/ax/hitl";

// Synthetic fixtures: the user's five actual records are not available to this checkout.
const QUESTIONS = ["입력 자료의 컬럼과 값을 알려주세요", "승인 기준 자료를 알려주세요"];
const csv = (name: string, content: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
const question = (page: Page, text: string) => page.locator(".ax-question").filter({
  has: page.locator(".ax-question-head label").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*·\\s*이전 질문 기록)?$`) }),
});
const upload = (page: Page, text: string) => question(page, text).locator('input[type="file"]');
async function state(page: Page): Promise<AxStateV2> {
  return page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("worklens-ax", 1);
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    try {
      const loaded = Promise.withResolvers<AxStateV2>();
      const read = db.transaction("state").objectStore("state").get("current");
      read.onsuccess = () => loaded.resolve(read.result); read.onerror = () => loaded.reject(read.error);
      return await loaded.promise;
    } finally { db.close(); }
  });
}
function tasks(): AxTaskV2[] {
  const diagnosis = { ...structuredClone(diagnosisFixture), followUpQuestions: QUESTIONS };
  const item = extractReviewableItems(diagnosis).find(item => item.type === "step")!;
  return [{ ...taskFixture("question-a", diagnosis), reviews: [{
    id: "existing-review", target: { key: item.key, type: item.type, source: item.source, sourceText: item.text, sourceHash: item.sourceHash },
    action: "keep", status: "confirmed", comment: "기존 담당자 검토 근거", reviewedAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
  }] }, taskFixture("question-b", diagnosis)];
}
async function open(page: Page) {
  await page.goto("/");
  await page.evaluate(async value => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("worklens-ax", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error);
    const db = await opened.promise;
    const saved = Promise.withResolvers<void>();
    const tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(value, "current");
    tx.oncomplete = () => saved.resolve(); tx.onerror = () => saved.reject(tx.error);
    await saved.promise; db.close();
  }, { ...emptyAxState(), tasks: tasks(), selectedTaskId: "question-a", step: 2 });
  await navigateWorkspace(page, "업무 자동화 진단");
  await expect(question(page, QUESTIONS[0])).toBeVisible();
}
async function mockAi(page: Page, calls: Record<string, unknown>[], nextQuestions: () => string[] = () => QUESTIONS) {
  await page.route("**/api/ai", async route => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: { ...outputFixture(), followUpQuestions: nextQuestions() } } } });
  });
}
async function rediagnose(page: Page, calls: Record<string, unknown>[]) {
  const count = calls.length;
  await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
  await expect.poll(() => calls.length).toBe(count + 1);
  await expect(page.getByRole("button", { name: "답변 반영 후 재진단", exact: true })).toBeEnabled();
  await expect.poll(async () => (await state(page)).tasks[0].followUpDiagnosis).toBeDefined();
  return String(calls[count].attachmentSummary);
}

for (const width of [1440, 390]) {
  test(`question CSV/XLSX survives reload, feeds real extracted evidence and retains HITL ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const calls: Record<string, unknown>[] = []; await mockAi(page, calls); await open(page);
    const original = (await state(page)).tasks;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("승인기준").addRows([["승인코드", "한도"], ["APPROVAL_XLSX_731", 731]]);
    await upload(page, QUESTIONS[0]).setInputFiles(csv("입력.csv", "검증코드,수량\nCSV_INPUT_842,842"));
    await expect(question(page, QUESTIONS[0]).getByText("입력.csv", { exact: true })).toBeVisible();
    await upload(page, QUESTIONS[1]).setInputFiles({ name: "승인.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
    await expect.poll(async () => (await state(page)).tasks[0].followUpResponses?.map(record => record.attachments.length)).toEqual([1, 1]);
    const before = (await state(page)).tasks[0].followUpResponses!;
    expect(before.every(record => record.answer === "")).toBe(true);
    expect(before[0].attachments[0].name).toBe("입력.csv");
    expect(before[1].attachments[0].name).toBe("승인.xlsx");
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    await expect(question(page, QUESTIONS[0]).getByText("입력.csv", { exact: true })).toBeVisible();
    await expect(question(page, QUESTIONS[1]).getByText("승인.xlsx", { exact: true })).toBeVisible();
    const summary = await rediagnose(page, calls);
    for (const value of [...QUESTIONS, "입력.csv", "승인.xlsx", "CSV_INPUT_842", "APPROVAL_XLSX_731"]) expect(summary).toContain(value);
    expect(calls[0]).not.toHaveProperty("bytes");
    const after = (await state(page)).tasks;
    expect(after[0].followUpResponses).toEqual(before);
    expect(after[0].reviews).toEqual(original[0].reviews);
    expect(after[1]).toEqual(original[1]);
    await page.getByRole("region", { name: "단계별 자동화 판단", exact: true }).locator('[data-slot="accordion-trigger"]').click();
    await expect(page.locator('#ax-step-review [data-status="confirmed"]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`question identity survives reorder/removal, task files stay isolated and individual removal persists ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    let currentQuestions = [...QUESTIONS]; const calls: Record<string, unknown>[] = [];
    await mockAi(page, calls, () => currentQuestions); await open(page);
    await question(page, QUESTIONS[0]).getByRole("textbox").fill("첫 질문의 저장 답변");
    await upload(page, QUESTIONS[0]).setInputFiles([csv("공통.csv", "코드\nTASK_A_FIRST"), csv("개별삭제.csv", "코드\nREMOVE_ONLY")]);
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(2);
    await upload(page, QUESTIONS[1]).setInputFiles(csv("공통.csv", "코드\nTASK_A_SECOND"));
    await expect(question(page, QUESTIONS[1]).locator(".ax-file-row")).toHaveCount(1);
    const firstRecords = (await state(page)).tasks[0].followUpResponses!;
    await page.locator(".ax-task-row-btn").filter({ hasText: "업무 question-b" }).click();
    await expect.poll(async () => (await state(page)).selectedTaskId).toBe("question-b");
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(0);
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("");
    await upload(page, QUESTIONS[0]).setInputFiles(csv("공통.csv", "코드\nTASK_B_PRIVATE"));
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(1);
    await page.locator(".ax-task-row-btn").filter({ hasText: "업무 question-a" }).click();
    // Selection autosaves too. Finish it before asserting that unchanged answers
    // (including their save timestamps) survive a subsequent diagnosis verbatim.
    await expect.poll(async () => (await state(page)).selectedTaskId).toBe("question-a");
    currentQuestions = [...QUESTIONS].reverse();
    let summary = await rediagnose(page, calls);
    expect(summary).not.toContain("TASK_B_PRIVATE");
    for (const value of ["TASK_A_FIRST", "TASK_A_SECOND"]) expect(summary).toContain(value);
    await expect(page.locator(".ax-question-head label").first()).toHaveText(QUESTIONS[1]);
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("첫 질문의 저장 답변");
    expect((await state(page)).tasks[0].followUpResponses).toEqual(firstRecords);
    currentQuestions = [QUESTIONS[1], `${QUESTIONS[0]} (새 질문)`];
    await rediagnose(page, calls);
    await expect(question(page, QUESTIONS[0]).filter({ has: page.getByText("이전 질문 기록", { exact: false }) })).toHaveAttribute("data-archived", "true");
    await expect(question(page, currentQuestions[1]).getByRole("textbox")).toHaveValue("");
    await expect(question(page, currentQuestions[1]).locator(".ax-file-row")).toHaveCount(0);
    await question(page, QUESTIONS[0]).filter({ has: page.locator('[aria-label="개별삭제.csv 첨부 해제"]') }).getByRole("button", { name: "개별삭제.csv 첨부 해제", exact: true }).click();
    await expect.poll(async () => (await state(page)).tasks[0].followUpResponses?.find(record => record.question === QUESTIONS[0])?.attachments.map(meta => meta.name)).toEqual(["공통.csv"]);
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    summary = await rediagnose(page, calls);
    expect(summary).toContain("TASK_A_FIRST"); expect(summary).toContain("TASK_A_SECOND");
    expect(summary).not.toContain("REMOVE_ONLY"); expect(summary).not.toContain("TASK_B_PRIVATE");
    const b = (await state(page)).tasks[1].followUpResponses!;
    expect(b).toHaveLength(1); expect(b[0].attachments).toHaveLength(1);
  });

  test(`invalid, excess and unparseable files preserve answers and usable evidence ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const calls: Record<string, unknown>[] = []; await mockAi(page, calls); await open(page);
    await question(page, QUESTIONS[0]).getByRole("textbox").fill("오류와 무관하게 보존할 텍스트");
    await upload(page, QUESTIONS[0]).setInputFiles({ name: "unsupported.exe", mimeType: "application/octet-stream", buffer: Buffer.from("unsupported") });
    await expect(page.getByText(/지원하지 않는 파일 형식/)).toBeVisible();
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(0);
    await upload(page, QUESTIONS[0]).setInputFiles([
      csv("정상.csv", "코드\nUSABLE_EVIDENCE_912"),
      { name: "손상.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("not a zip workbook") },
      ...Array.from({ length: 9 }, (_, i) => csv(`추가${i}.csv`, `코드\nEXTRA_${i}`)),
    ]);
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(10);
    await expect(page.getByText(/질문당 최대 10개/)).toBeVisible();
    const summary = await rediagnose(page, calls);
    expect(summary).toContain("USABLE_EVIDENCE_912"); expect(summary).toContain("손상.xlsx"); expect(summary).toContain("분석 불가");
    expect(JSON.stringify(calls[0])).toContain("오류와 무관하게 보존할 텍스트");
    const saved = (await state(page)).tasks[0].followUpResponses![0];
    expect(saved.answer).toBe("오류와 무관하게 보존할 텍스트"); expect(saved.attachments).toHaveLength(10);
    expect(saved.attachments.some(meta => meta.name === "손상.xlsx")).toBe(true);
    expect(saved.attachments.some(meta => meta.name === "추가8.csv")).toBe(false);
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue(saved.answer);
    await expect(question(page, QUESTIONS[0]).locator(".ax-file-row")).toHaveCount(10);
  });

  test(`storage failure keeps entered information and supports retry without losing existing files ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const calls: Record<string, unknown>[] = []; await mockAi(page, calls);
    await open(page);
    await upload(page, QUESTIONS[0]).setInputFiles(csv("기존.csv", "코드\nEXISTING_FILE"));
    await expect.poll(async () => (await state(page)).tasks[0].followUpResponses?.[0].attachments.length).toBe(1);
    const before = await state(page);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      Object.assign(window, { restoreQuestionFilePut: () => { IDBObjectStore.prototype.put = put; } });
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "state") throw new DOMException("Test quota exhausted", "QuotaExceededError");
        return put.apply(this, args);
      };
    });
    await question(page, QUESTIONS[0]).getByRole("textbox").fill("저장 실패 시 유지할 입력");
    await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).click();
    await expect(page.getByText(/답변 저장 실패/)).toBeVisible();
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("저장 실패 시 유지할 입력");
    await upload(page, QUESTIONS[0]).setInputFiles(csv("저장실패.csv", "코드\nFAILED_NEW_FILE"));
    await expect(page.getByText(/저장 실패/).last()).toBeVisible();
    await expect(question(page, QUESTIONS[0]).getByText("기존.csv", { exact: true })).toBeVisible();
    expect(await state(page)).toEqual(before);
    expect(calls).toHaveLength(0);
    await page.evaluate(() => (window as unknown as { restoreQuestionFilePut: () => void }).restoreQuestionFilePut());
    await rediagnose(page, calls);
    await expect.poll(async () => (await state(page)).tasks[0].followUpResponses?.[0].answer).toBe("저장 실패 시 유지할 입력");
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("저장 실패 시 유지할 입력");
    const fileLayout = await question(page, QUESTIONS[0]).locator(".ax-file-row").evaluate(node => {
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, right: box.right, bottom: box.bottom };
      };
      return { row: rect(node), name: rect(node.querySelector(".ax-file-name")!), status: rect(node.querySelector(".ax-file-status")!), scrollWidth: document.documentElement.scrollWidth };
    });
    await testInfo.attach("question-file-layout.json", { body: JSON.stringify(fileLayout, null, 2), contentType: "application/json" });
    expect(fileLayout.name.width).toBeGreaterThan(0);
    expect(fileLayout.name.right).toBeLessThanOrEqual(fileLayout.row.right);
    expect(fileLayout.status.right).toBeLessThanOrEqual(fileLayout.row.right);
    expect(fileLayout.scrollWidth).toBe(width);
    if (width === 390) expect(fileLayout.status.y).toBeGreaterThanOrEqual(fileLayout.name.bottom);
    await expect(question(page, QUESTIONS[0]).getByText("기존.csv", { exact: true })).toBeVisible();
    // Export carries metadata only, never the persisted original Blob or its extracted content.
    await page.getByRole("button", { name: "AI•AX 데이터 작업", exact: true }).click();
    const download = page.waitForEvent("download"); await page.getByRole("menuitem", { name: "데이터 내보내기", exact: true }).click();
    const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"));
    expect(exported.data.tasks[0].followUpResponses[0].attachments[0].name).toBe("기존.csv");
    expect(JSON.stringify(exported)).not.toContain("EXISTING_FILE");
  });
}

for (const width of [1440, 390]) {
  test(`question UI reuses registration styling and unified save handles partial failure and retry ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await open(page);
    const original = (await state(page)).tasks;
    await expect(page.locator(".ax-questions > .ax-muted")).toHaveCount(0);
    await expect(page.locator(".ax-questions").getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
    const style = (selector: string) => page.locator(selector).first().evaluate(node => {
      const field = getComputedStyle(node), control = getComputedStyle(node.querySelector("textarea")!);
      return { background: field.backgroundColor, border: field.border, radius: field.borderRadius,
        padding: control.padding, color: control.color, placeholder: getComputedStyle(node.querySelector("textarea")!, "::placeholder").color };
    });
    const questionStyle = await style('.ax-question [data-slot="textarea-control"]');
    const spacing = await page.locator(".ax-questions").evaluate(node => {
      const questions = [...node.querySelectorAll(".ax-question")];
      const last = questions.at(-1)!.getBoundingClientRect(), button = node.querySelector(".ax-rediagnose")!.getBoundingClientRect();
      return { titleGap: questions[0].getBoundingClientRect().y - node.querySelector("h3")!.getBoundingClientRect().bottom,
        questionGap: questions[1].getBoundingClientRect().y - questions[0].getBoundingClientRect().bottom,
        labelGaps: questions.map(q => q.querySelector('[data-slot="textarea-control"]')!.getBoundingClientRect().y - q.querySelector(".ax-question-head")!.getBoundingClientRect().bottom),
        buttonGap: button.y - last.bottom, rightDifference: last.right - button.right,
        heights: questions.map(q => q.querySelector("textarea")!.getBoundingClientRect().height),
        maxLengths: questions.map(q => q.querySelector("textarea")!.maxLength) };
    });
    // DOMRect subtraction includes browser float rounding (e.g. 20.0000305px).
    // Keep the design values within 0.005 CSS px, below a rendered pixel.
    expect(spacing.titleGap).toBeCloseTo(20, 2); expect(spacing.questionGap).toBeCloseTo(20, 2);
    for (const gap of spacing.labelGaps) expect(gap).toBeCloseTo(8, 2);
    expect(spacing.buttonGap).toBeCloseTo(20, 2);
    expect(spacing.rightDifference).toBeCloseTo(0, 2); expect(spacing.maxLengths).toEqual([500, 500]);
    await page.getByRole("tab", { name: "업무 등록", exact: true }).click();
    expect(await style('.ax-register .ax-field [data-slot="textarea-control"]')).toEqual(questionStyle);
    await testInfo.attach("question-design.json", { body: JSON.stringify({ questionStyle, spacing }, null, 2), contentType: "application/json" });
    await page.getByRole("tab", { name: "업무 진단", exact: true }).click();
    await question(page, QUESTIONS[0]).getByRole("textbox").fill("ANSWER_FIRST_812");
    await question(page, QUESTIONS[1]).getByRole("textbox").fill("ANSWER_SECOND_926");
    // Keep task-specific drafts isolated when switching away and back before saving.
    await page.locator(".ax-task-row-btn").filter({ hasText: "업무 question-b" }).click();
    await expect.poll(async () => (await state(page)).selectedTaskId).toBe("question-b");
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("");
    await question(page, QUESTIONS[0]).getByRole("textbox").fill("TASK_B_DRAFT");
    await page.locator(".ax-task-row-btn").filter({ hasText: "업무 question-a" }).click();
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("ANSWER_FIRST_812");
    await expect.poll(async () => (await state(page)).selectedTaskId).toBe("question-a");
    // Fail the second answer write after the first has actually committed.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put; let writes = 0;
      Object.assign(window, { restoreQuestionPut: () => { IDBObjectStore.prototype.put = put; } });
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "state" && ++writes === 2) throw new DOMException("Second answer quota failure", "QuotaExceededError");
        return put.apply(this, args);
      };
    });
    const snapshots: AxStateV2[] = [], calls: Record<string, unknown>[] = [];
    let failAi = true;
    await page.route("**/api/ai", async route => {
      snapshots.push(await state(page)); calls.push(route.request().postDataJSON());
      // During diagnosis, switching tasks and repeated submissions are disabled.
      expect(await page.locator(".ax-task-row-btn").first().isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "답변 반영 후 재진단", exact: true }).isDisabled()).toBe(true);
      if (failAi) await route.fulfill({ status: 500, json: { error: "로컬 진단 실패 테스트" } });
      else await route.fulfill({ json: { data: { kind: "ax-diagnosis", diagnosis: { ...outputFixture(), followUpQuestions: QUESTIONS } } } });
    });
    const submit = page.getByRole("button", { name: "답변 반영 후 재진단", exact: true });
    await submit.click();
    await expect(page.getByText(/답변 저장 실패/)).toBeVisible();
    expect(calls).toHaveLength(0);
    await expect(question(page, QUESTIONS[1]).getByRole("textbox")).toHaveValue("ANSWER_SECOND_926");
    expect((await state(page)).tasks[0].followUpResponses?.map(record => record.answer)).toEqual(["ANSWER_FIRST_812"]);
    await page.evaluate(() => (window as unknown as { restoreQuestionPut: () => void }).restoreQuestionPut());
    await submit.click();
    await expect(page.getByText(/진단 실패 ·/)).toBeVisible();
    const saved = await state(page);
    expect(saved.tasks[0].followUpResponses?.map(record => record.answer)).toEqual(["ANSWER_FIRST_812", "ANSWER_SECOND_926"]);
    expect(snapshots[0].tasks[0].followUpResponses).toEqual(saved.tasks[0].followUpResponses);
    expect(saved.tasks[0].diagnosis).toEqual(original[0].diagnosis);
    expect(saved.tasks[0].reviews).toEqual(original[0].reviews);
    expect(saved.tasks[1]).toEqual(original[1]);
    expect(JSON.stringify(calls[0])).toContain("ANSWER_FIRST_812");
    expect(JSON.stringify(calls[0])).toContain("ANSWER_SECOND_926");
    expect(JSON.stringify(calls[0])).not.toContain("TASK_B_DRAFT");
    await page.reload(); await navigateWorkspace(page, "업무 자동화 진단");
    await expect(question(page, QUESTIONS[0]).getByRole("textbox")).toHaveValue("ANSWER_FIRST_812");
    await expect(question(page, QUESTIONS[1]).getByRole("textbox")).toHaveValue("ANSWER_SECOND_926");
    failAi = false;
    await rediagnose(page, calls);
    const after = await state(page);
    expect(after.tasks[0].followUpResponses).toEqual(saved.tasks[0].followUpResponses);
    expect(after.tasks[0].reviews).toEqual(original[0].reviews);
    expect(after.tasks[1]).toEqual(original[1]);
    expect(errors).toEqual([]);
  });
}
