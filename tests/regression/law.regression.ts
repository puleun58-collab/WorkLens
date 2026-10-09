import { expect, type Page } from "@playwright/test";
import { createDocxParagraphs } from "../fixtures";
import { fullResearchFixture } from "../fixtures/research";
import { navigateWorkspace } from "../e2e/navigation";
import { noHorizontalOverflow, regressionCase, upload, writeFixture } from "./record";

const missing = (task: string) => ({ data: { found: false, task, marker: "NOT_FOUND", text: "[NOT_FOUND]", markers: ["NOT_FOUND"] } });
async function ready(page: Page, view: string) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-hydrated", "true");
  await navigate(page, view);
}
async function navigate(page: Page, view: string) {
  if (view === "분석" || view === "법령") {
    await navigateWorkspace(page, view);
    return;
  }
  await navigateWorkspace(page, "법령");
  await page.getByRole("tab", { name: view === "문서 검토" ? "종합 리서치" : view, exact: true }).click();
  if (view === "문서 검토") {
    await page.getByRole("combobox", { name: "리서치 유형", exact: true }).click();
    await page.getByRole("option", { name: "문서 검토", exact: true }).click();
  }
}
const meta = (id: string, input: string, expected: string, mobile = false) => ({
  id, category: "Law" as const, input, expected, format: "mock API", structure: "browser request and rendered result", mobile,
});

regressionCase(meta("LAW-B01", "Law search to TOC and article", "Selected MST and article are sent; source text survives navigation", true), async ({ page, note }) => {
  const requests: unknown[] = [];
  await page.route("**/api/law", (route) => route.fulfill({ json: { data: { found: true, text: "", laws: [{ name: "근로기준법", mst: "283457", lawId: "001872", status: "현행" }] } } }));
  await page.route("**/api/law/text", async (route) => {
    const request = route.request().postDataJSON(); requests.push(request);
    await route.fulfill({ json: { data: request.jo
      ? { found: true, mode: "article", name: "근로기준법", text: "제23조(해고 등의 제한) 사용자는 근로자에게 정당한 이유 없이 해고를 하지 못한다." }
      : { found: true, mode: "toc", name: "근로기준법", text: "목차", articles: [{ jo: "제23조", title: "해고 등의 제한" }] } } });
  });
  await ready(page, "법령");
  await page.getByRole("searchbox", { name: "법령명 또는 키워드 검색" }).fill("근로기준법");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".law-search-list").getByRole("button", { name: /근로기준법/u }).click();
  await page.getByRole("navigation", { name: "조문 목차" }).getByRole("button", { name: "제23조 해고 등의 제한" }).click();
  await expect(page.locator(".law-detail-raw")).toContainText("정당한 이유 없이");
  expect(requests).toEqual([{ mst: "283457" }, { mst: "283457", jo: "제23조" }]);
  await page.getByRole("button", { name: "← 목차로" }).click();
  await expect(page.getByRole("navigation", { name: "조문 목차" })).toBeVisible();
  expect(requests).toHaveLength(2);
  await noHorizontalOverflow(page); note("MST and article retained; returning to cached TOC sends no extra request.");
});

regressionCase(meta("LAW-B02", "Precedent search to compact/full detail", "Zero-padded identity, explicit full request and cached text retained"), async ({ page, note }) => {
  const requests: unknown[] = [];
  const entry = { domain: "precedent", id: "000123", title: "부당해고", caseNumber: "2024두123", court: "대법원" };
  await page.route("**/api/law/decisions/search", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ domain: "precedent", query: "부당해고", page: 1 });
    await route.fulfill({ json: { data: { found: true, entries: [entry], text: "검색 원문", page: 1, totalCount: 1, hasNext: false } } });
  });
  await page.route("**/api/law/decisions/text", async (route) => {
    const request = route.request().postDataJSON(); requests.push(request);
    await route.fulfill({ json: { data: { found: true, text: request.full ? "판시사항: 전문 추가 내용" : "판시사항: 축약 원문", expandable: !request.full } } });
  });
  await ready(page, "판례·결정례");
  await page.getByRole("searchbox", { name: "검색어", exact: true }).fill("부당해고");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".decision-search-list").getByRole("button").click();
  await expect(page.locator(".decision-detail-raw")).toContainText("축약 원문");
  await page.getByRole("button", { name: "전문 보기", exact: true }).click();
  await expect(page.locator(".decision-detail-raw")).toContainText("전문 추가 내용");
  await page.getByRole("button", { name: "← 검색 결과로" }).click();
  await page.locator(".decision-search-list").getByRole("button").click();
  await expect(page.locator(".decision-detail-raw")).toContainText("전문 추가 내용");
  expect(requests).toEqual([{ domain: "precedent", id: "000123" }, { domain: "precedent", id: "000123", full: true }]);
  note("Mock precedent identity is preserved; full text loads only on explicit action and remains cached.");
});

regressionCase(meta("LAW-B03", "Nonexistent precedent and malformed success", "Missing is a zero-result status; broken envelope is an error with no invented record", true), async ({ page, note }) => {
  let calls = 0;
  await page.route("**/api/law/decisions/search", (route) => route.fulfill({ json: ++calls === 1
    ? { data: { found: false, marker: "NOT_FOUND", text: "[NOT_FOUND]" } }
    : { data: { found: true, entries: [{ title: "형식 오류" }] } } }));
  await ready(page, "판례·결정례");
  const search = page.getByRole("searchbox", { name: "검색어", exact: true });
  await search.fill("존재하지않는가상판례"); await search.press("Enter");
  await expect(page.locator(".decision-search-list li")).toHaveCount(0);
  await search.fill("형식 오류 응답"); await search.press("Enter");
  await expect(page.locator(".decision-search-results [role=alert]")).toBeVisible();
  await expect(page.locator(".decision-search-results")).not.toContainText("형식 오류");
  await expect(page.locator(".decision-search-list li")).toHaveCount(0);
  await noHorizontalOverflow(page); note("Missing and malformed responses never create a precedent entry.");
});

regressionCase(meta("LAW-B04", "Full research partial source response", "Returned decisions stay bounded; failed/time-limited sections remain disclosed"), async ({ page, note }) => {
  await page.route("**/api/law/research", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ task: "full_research", query: "직장 내 괴롭힘 판단 기준" });
    await route.fulfill({ json: { data: { found: true, task: "full_research", text: fullResearchFixture(), markers: ["NOT_FOUND", "FAILED"] } } });
  });
  await ready(page, "종합 리서치");
  await page.getByLabel("질문 또는 검색어", { exact: true }).fill("직장 내 괴롭힘 판단 기준");
  await page.getByRole("button", { name: "실행", exact: true }).click();
  const result = page.locator(".legal-research .legal-analysis-result");
  await expect(result).toContainText("직장 내 괴롭힘의 금지");
  await expect(result.locator('[data-kind="decision_search"] .research-hits > li')).toHaveCount(5);
  await expect(result.locator('[data-status="not_found"]')).toContainText("자료 없음");
  await expect(result.getByRole("note")).toHaveText("일부 자료 조회가 완료되지 않아 확인된 결과만 표시합니다.");
  // STATUS_NOTE is rendered on a p.research-empty-line, not a status badge.
  // The generic partial notice cannot replace disclosure of the timed-out section.
  const timeoutSection = result.locator('p.legal-analysis-section.research-empty-line[data-status="timeout"]');
  await expect(timeoutSection).toBeVisible();
  await expect(timeoutSection).toHaveText("AI 검색 보완 정보 · 조회를 마치지 못했습니다");
  const source = result.locator("details.research-source");
  await source.locator("summary").click();
  await expect(source.locator(".legal-analysis-raw")).toBeVisible();
  await expect(source).toContainText("총 67건");
  await expect(result).not.toContainText(/판례 제목 6|<br\/>|get_precedent_text/u);
  note("Captured partial-chain fixture preserves statutes, reported total and unavailable sections without inventing a sixth hit.");
});

regressionCase(meta("LAW-B05", "Pasted review stale input and retry snapshot", "Retry sends failed A after edit to B; no evidence creates no legal findings"), async ({ page, note }) => {
  const a = "계약서 내용 A를 검토합니다. 당사자는 조건을 확인합니다.";
  const b = "계약서 내용 B를 검토합니다. 당사자는 다른 조건을 확인합니다.";
  const requests: unknown[] = [];
  await page.route("**/api/law/research", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill(requests.length === 1
      ? { status: 502, json: { error: { message: "검토 서비스 조회 실패" } } }
      : { json: missing("document_review") });
  });
  await ready(page, "문서 검토");
  await page.getByRole("radio", { name: "직접 입력", exact: true }).check();
  const text = page.getByLabel("검토할 문서 내용", { exact: true });
  await text.fill(a); await page.getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  await text.fill(b);
  await expect(page.locator('[data-review-stale="true"]')).toBeVisible();
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.locator(".legal-analysis-missing")).toContainText("관련 근거를 확인하지 못했습니다");
  expect(requests).toEqual([{ task: "document_review", text: a }, { task: "document_review", text: a }]);
  await expect(page.locator('[data-review-stale="true"]')).toBeVisible();
  await page.getByRole("button", { name: "실행", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toEqual({ task: "document_review", text: b });
  await expect(page.locator('[data-review-stale="true"]')).toHaveCount(0);
  await expect(page.locator(".legal-analysis-missing")).toContainText("조회되지 않았다고 관련 법령이나 판례가 없다는 뜻은 아닙니다.");
  note("Failed text snapshot stays attached to retry; ordinary execution adopts edited input and clears stale state.");
});

regressionCase(meta("LAW-B06", "File review retry after selecting another file", "Retry retains original document identity and segment provenance"), async ({ page, note }) => {
  const requests: Array<{ document: { id: string; name: string; segments: unknown[] } }> = [];
  await page.route("**/api/law/research", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill(requests.length === 1 ? { status: 502, json: { error: { message: "검토 실패" } } } : { json: missing("document_review") });
  });
  await ready(page, "분석");
  const a = await writeFixture("registry-review-a.docx", createDocxParagraphs(["용역 계약서 A", "당사자는 조건을 협의하여 업무를 진행한다."]));
  const b = await writeFixture("registry-review-b.docx", createDocxParagraphs(["용역 계약서 B", "당사자는 다른 조건을 협의하여 업무를 진행한다."]));
  await upload(page, a, b); await navigate(page, "문서 검토");
  await page.getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  expect(requests[0].document.name).toBe("registry-review-a.docx");
  expect(requests[0].document.segments.length).toBeGreaterThan(0);
  await page.getByRole("combobox", { name: "검토할 문서", exact: true }).click();
  await page.getByRole("option", { name: "registry-review-b.docx", exact: true }).click();
  await expect(page.locator('[data-review-stale="true"]')).toBeVisible();
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.locator(".legal-analysis-missing")).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.locator('[data-review-stale="true"]')).toBeVisible();
  await page.getByRole("button", { name: "실행", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].document.name).toBe("registry-review-b.docx");
  expect(requests[2].document.id).not.toBe(requests[0].document.id);
  await expect(page.locator('[data-review-stale="true"]')).toHaveCount(0);
  note("File retry preserves A's exact projected DTO; a new execution reviews B.");
});

regressionCase(meta("COMMON-B01", "Research repeated Enter, task cancellation and healthy console", "One pending request; cancelled result cannot publish; fresh result has no console/page errors"), async ({ page, note }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let finishFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  let calls = 0;
  await page.route("**/api/law/research", async (route) => {
    const first = ++calls === 1;
    if (first) await held;
    await route.fulfill({ json: missing("full_research") });
    if (first) finishFirst();
  });
  await ready(page, "종합 리서치");
  const query = page.getByLabel("질문 또는 검색어", { exact: true });
  await query.fill("첫 번째 조사"); await query.press("Enter");
  await expect(page.getByRole("button", { name: "리서치 중…", exact: true })).toBeDisabled();
  await query.press("Enter"); await query.press("Enter");
  expect(calls).toBe(1);
  await page.getByRole("combobox", { name: "리서치 유형", exact: true }).click();
  await page.getByRole("option", { name: "법체계 확인", exact: true }).click();
  release();
  await firstFinished;
  await page.getByRole("combobox", { name: "리서치 유형", exact: true }).click();
  await page.getByRole("option", { name: "통합 조사", exact: true }).click();
  await expect(page.locator(".legal-research .legal-analysis-result")).toHaveCount(0);
  await query.fill("두 번째 조사"); await query.press("Enter");
  await expect(page.locator(".legal-analysis-missing")).toContainText("두 번째 조사");
  expect(calls).toBe(2); expect(errors).toEqual([]);
  note("Repeated submissions are bounded; switching tasks discards cancelled work; fresh no-evidence flow is console-clean.");
});
