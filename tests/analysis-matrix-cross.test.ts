import { describe, expect, it } from "vitest";
import { claimDisplayText } from "@/lib/analysis-presentation";
import { MAX_ANALYZE_EVIDENCE_CHARS, MAX_EVIDENCE_ITEMS } from "@/lib/ai/prompt";
import {
  coverage,
  expectCovers,
  expectGrounded,
  expectNoExactRepeats,
  runAnalyze,
  visibleTexts,
  windowTexts,
  type AnalyzeRun,
  type MatrixFile,
} from "./analysis-quality-harness";
import {
  deckFile,
  h,
  p,
  pdfFile,
  sameContentPdf,
  sameContentPptx,
  sameContentXlsx,
  seeded,
  xlsxFile,
  type DeckSlide,
} from "./analysis-matrix-fixtures";

const deterministic = (run: AnalyzeRun) => visibleTexts(run.fallback, run.metrics);

/** Meaning of the shared business content; each concept may be worded or laid out differently per format. */
const SAME_MEANING = {
  goal: /처리시간.*20% 단축/u,
  baseline: /(?:평균 처리시간은 10일|10일.*목표는 8일|기준.*10일)/u,
  target: /목표(?:는|\(일\)|: )? ?8일?|목표는 8일/u,
  process: /접수.*검토.*승인.*완료/u,
  september: /9월.*(?:평균 처리시간(?:은|\(일\))?(?: · |: | )?8|8일)/u,
};

describe("Analyze matrix · cross-format, multi-file, grounding and stress", () => {
  it("CROSS-01..03 the same business content as PDF, XLSX and PPTX yields the same meaning coverage", async () => {
    const runs = {
      pdf: await runAnalyze([await sameContentPdf()]),
      xlsx: await runAnalyze([await sameContentXlsx()]),
      pptx: await runAnalyze([sameContentPptx()]),
    };
    const table: Record<string, { deterministic: string[]; window: string[] }> = {};
    for (const [format, run] of Object.entries(runs)) {
      table[format] = {
        deterministic: coverage(deterministic(run), SAME_MEANING).missed,
        window: coverage([windowTexts(run).join(" ")], SAME_MEANING).missed,
      };
    }
    const report = JSON.stringify(table);
    for (const format of Object.keys(runs)) {
      // The model sees every concept in every format.
      expect(table[format].window, `${format} window ${report}`).toEqual([]);
      // What the user sees without AI may differ by at most one concept between formats.
      expect(table[format].deterministic.length, `${format} deterministic ${report}`).toBeLessThanOrEqual(1);
    }
    for (const run of Object.values(runs)) {
      const { presented } = run.enrich([
        { text: "처리시간을 20% 단축하는 것이 목표입니다.", evidence: [/20% 단축/u], role: "summary" },
        { text: "긴급 건은 선처리 후 사후 승인할 수 있습니다.", evidence: [/긴급 건/u], role: "summary" },
      ]);
      expect(presented.summary).toHaveLength(2);
      expectGrounded(presented, run.documents);
      expectNoExactRepeats(presented);
    }
  });

  it("MULTI-01..04 mixed-format runs keep provenance per file, name files, and let no format monopolize", async () => {
    const files = { pdf: await sameContentPdf(), xlsx: await sameContentXlsx(), pptx: sameContentPptx() };
    const combos: Array<Array<keyof typeof files>> = [["pdf", "xlsx"], ["pdf", "pptx"], ["xlsx", "pptx"], ["pdf", "xlsx", "pptx"]];
    for (const combo of combos) {
      const selected = combo.map((key) => files[key]);
      const run = await runAnalyze(selected);
      const names = new Map(selected.map((file) => [file.fileId, file.fileName]));
      for (const item of run.items) {
        const file = item.sources[0].fileId;
        expect(item.sources.every((source) => source.fileId === file), item.text).toBe(true);
        expect(item.text.startsWith(`${names.get(file)}: `), item.text).toBe(true);
      }
      const itemsByFile = new Set(run.items.map((item) => item.sources[0].fileId));
      expect(itemsByFile.size, combo.join("+")).toBe(combo.length);
      const windowByFile = new Map<string, number>();
      for (const item of run.window.items) {
        const fileId = run.window.nodes.get(item.handle)!.fileId;
        windowByFile.set(fileId, (windowByFile.get(fileId) ?? 0) + 1);
      }
      expect(windowByFile.size, combo.join("+")).toBe(combo.length);
      for (const document of run.documents) {
        for (const block of document.blocks) expect(block.source.fileId).toBe(document.fileId);
      }
    }
  });

  it("CONFLICT-01 three files state three targets: all survive with their own source; an averaged or merged value is rejected", async () => {
    const run = await runAnalyze([
      await pdfFile("c-pdf", "계획서.pdf", [[h("목표"), p("연간 처리 목표는 100건입니다.")]]),
      await xlsxFile("c-xlsx", "계획표.xlsx", [{ name: "목표", rows: [["항목", "값"], ["연간 처리 목표", 120]] }]),
      deckFile("c-pptx", "보고.pptx", [{ title: "목표", texts: ["연간 처리 목표는 130건입니다."] }]),
    ]);
    const texts = deterministic(run).join("\n");
    for (const value of ["100건", "120", "130건"]) expect(texts).toContain(value);
    const { grounded, presented } = run.enrich([
      { text: "연간 처리 목표는 문서마다 100건, 120, 130건으로 다릅니다.", evidence: [/100건/u, /연간 처리 목표.*120/u, /130건/u], role: "insight" },
      { text: "연간 처리 목표는 평균 116.7건입니다.", evidence: [/100건/u, /130건/u], role: "summary" },
      { text: "연간 처리 목표는 120건으로 확정되었습니다.", evidence: [/100건/u], role: "summary" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(2);
    const conflict = presented.insights[0];
    expect(new Set(conflict.evidence.map(({ source }) => source.fileId))).toEqual(new Set(["c-pdf", "c-xlsx", "c-pptx"]));
    expect(visibleTexts(presented).join("\n")).not.toMatch(/116\.7/u);
  });

  it("STRESS-01 three paraphrases of one rule are not shown three times", async () => {
    const run = await runAnalyze([await pdfFile("st1", "등록.pdf", [[
      h("등록 원칙"),
      p("승인 후 시스템에 등록한다."),
      p("시스템 등록은 승인 완료 후 진행한다."),
      p("승인이 끝나면 시스템에 등록한다."),
      p("등록 결과는 매주 금요일에 보고한다."),
    ]])]);
    const { presented } = run.enrich([
      { text: "승인이 완료되면 시스템에 등록한다.", evidence: [/승인 후 시스템에 등록/u, /승인 완료 후 진행/u, /승인이 끝나면/u], role: "summary" },
    ]);
    const restated = visibleTexts(presented).filter((text) => /승인/u.test(text) && /등록/u.test(text));
    expect(restated, restated.join(" | ")).toHaveLength(1);
    expectCovers(visibleTexts(presented), { weekly: /매주 금요일/u }, "STRESS-01");
  });

  it("PROTECT-01 similar-looking facts that differ in subject, value, direction or scope stay separate", async () => {
    const shared = [
      "A팀 처리기간은 10일입니다.",
      "B팀 처리기간은 15일입니다.",
      "매출은 20% 증가했습니다.",
      "이익은 5% 감소했습니다.",
      "기본 프로세스는 접수 후 검토를 거쳐 승인합니다.",
      "긴급 예외 프로세스는 승인 후 검토합니다.",
    ];
    const run = await runAnalyze([await pdfFile("pr1", "비교.pdf", [[h("현황"), ...shared.map(p)]])]);
    const { presented } = run.enrich([
      { text: "A팀 처리기간은 10일입니다.", evidence: [/A팀 처리기간/u], role: "summary" },
      { text: "매출은 20% 증가했습니다.", evidence: [/매출은 20%/u], role: "summary" },
    ]);
    const visible = visibleTexts(presented);
    for (const fact of [/A팀.*10일/u, /B팀.*15일/u, /매출.*20% 증가/u, /이익.*5% 감소/u, /기본 프로세스/u, /긴급 예외 프로세스/u]) {
      expect(visible.some((text) => fact.test(text)), `${fact} in ${visible.join(" | ")}`).toBe(true);
    }
  });

  it("ORDER-01 the same four-step procedure keeps its order in all three formats", async () => {
    const steps = ["신청", "검토", "승인", "실행"];
    const files: MatrixFile[] = [
      await pdfFile("o-pdf", "절차.pdf", [[h("처리 절차"), ...steps.map((step, index) => p(`${index + 1}. ${step} 단계를 처리합니다.`))]]),
      await xlsxFile("o-xlsx", "절차.xlsx", [{ name: "절차", rows: [["순서", "단계", "설명"], ...steps.map((step, index) => [index + 1, step, `${step} 단계를 처리합니다.`])] }]),
      deckFile("o-pptx", "절차.pptx", [{ title: "처리 절차", texts: [steps.join(" → ")] }]),
    ];
    for (const file of files) {
      const run = await runAnalyze([file]);
      const joined = windowTexts(run).join("\n");
      const positions = steps.map((step) => joined.indexOf(step));
      expect(positions.every((position) => position >= 0), `${file.fileName}: ${joined}`).toBe(true);
      expect([...positions].sort((a, b) => a - b), file.fileName).toEqual(positions);
    }
  });

  it("LATE-01 an exclusion at the very end of each format survives hundreds of ordinary facts", async () => {
    const exclusion = "단, 해외 사업장은 적용 제외.";
    const ordinary = (index: number) => `${index}번 지점은 월간 점검표를 제출합니다.`;
    const pdfPages = Array.from({ length: 20 }, (_, page) => [h(`${page + 1}장`), ...Array.from({ length: 12 }, (_, line) => p(ordinary(page * 12 + line + 1)))]);
    pdfPages.push([h("적용 범위"), p(exclusion)]);
    const slides: DeckSlide[] = Array.from({ length: 40 }, (_, slide) => ({ title: `현황 ${slide + 1}`, texts: Array.from({ length: 6 }, (_, line) => ordinary(slide * 6 + line + 1)) }));
    slides.push({ title: "적용 범위", texts: [exclusion] });
    const files: MatrixFile[] = [
      await pdfFile("l-pdf", "지침.pdf", pdfPages),
      await xlsxFile("l-xlsx", "지침.xlsx", [
        { name: "지점", rows: [["지점", "내용"], ...Array.from({ length: 240 }, (_, index) => [`${index + 1}번 지점`, ordinary(index + 1)])] },
        { name: "적용 범위", rows: [["항목", "내용"], ["예외", exclusion]] },
      ]),
      deckFile("l-pptx", "지침.pptx", slides),
    ];
    for (const file of files) {
      const run = await runAnalyze([file]);
      expectCovers(windowTexts(run), { exclusion: /해외 사업장은 적용 제외/u }, `${file.fileName} window`);
      expectCovers(deterministic(run), { exclusion: /해외 사업장은 적용 제외/u }, `${file.fileName} items`);
    }
  });

  it("EVIDENCE-01 the window respects item and character limits while keeping a late decisive fact", async () => {
    const long = (index: number) => `${index}번 항목은 일반 운영 기록으로서 특별한 조건이나 예외가 없는 일상적인 처리 내용을 길게 설명하는 문장입니다. `.repeat(2);
    const pages = Array.from({ length: 30 }, (_, page) => [h(`기록 ${page + 1}`), ...Array.from({ length: 8 }, (_, line) => p(long(page * 8 + line + 1).slice(0, 110)))]);
    pages.push([h("결정"), p("결론적으로 모든 기록은 5년간 보관하고 그 이후 폐기합니다.")]);
    const run = await runAnalyze([await pdfFile("ev1", "기록.pdf", pages)]);
    expect(run.window.items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS);
    const characters = run.window.items.reduce((sum, item) => sum + item.text.length, 0);
    expect(characters).toBeLessThanOrEqual(MAX_ANALYZE_EVIDENCE_CHARS);
    expectCovers(windowTexts(run), { decision: /5년간 보관/u }, "EVIDENCE-01");
  });

  it("GROUND-01..04 unknown handle, wrong number and unsupported advice are removed; valid claims survive with a warning", async () => {
    const run = await runAnalyze([await pdfFile("g1", "정산.pdf", [[
      h("정산 기준"),
      p("출장비는 출장 종료 후 7일 이내에 정산합니다."),
      p("정산이 늦어지면 다음 달 급여와 함께 지급합니다."),
    ]])]);
    const handle = run.window.items.find((item) => /7일 이내/u.test(item.text))!.handle;
    const payload = JSON.stringify({ claims: [
      { text: "출장비는 출장 종료 후 7일 이내에 정산합니다.", role: "summary", confidence: "high", sources: [handle] },
      { text: "출장비는 출장 종료 후 3일 이내에 정산합니다.", role: "summary", confidence: "high", sources: [handle] },
      { text: "정산 담당자를 추가로 배치해야 합니다.", role: "insight", confidence: "high", sources: [handle] },
      { text: "정산이 늦어지면 다음 달 급여와 함께 지급합니다.", role: "insight", confidence: "high", sources: ["ZZ99"] },
    ] });
    const { grounded, presented } = run.enrichRaw(payload);
    expect(grounded.rejectedClaimCount).toBe(3);
    expect(presented.summary.map(claimDisplayText)).toEqual(["출장비는 출장 종료 후 7일 이내에 정산합니다."]);
    expect(presented.warnings.map((warning) => warning.code)).toContain("EVIDENCE_VALIDATION_FAILED");
    expect(visibleTexts(presented).join("\n")).not.toMatch(/3일|배치해야/u);
    expectCovers(visibleTexts(presented), { late: /다음 달 급여/u }, "GROUND fallback content");
  });

  it("GROUND-05 a unit declared by the column header grounds a cell value; an invented unit or computed number does not", async () => {
    const run = await runAnalyze([await sameContentXlsx()]);
    const { grounded, presented } = run.enrich([
      { text: "9월 평균 처리시간은 8일입니다.", evidence: [/9월 평균 처리시간\(일\) · 8/u], role: "summary" },
      { text: "9월 평균 처리시간은 8주입니다.", evidence: [/9월 평균 처리시간\(일\) · 8/u], role: "summary" },
      { text: "8월 평균 처리시간은 목표보다 1일 길었습니다.", evidence: [/8월 평균 처리시간\(일\) · 9/u, /8월 목표\(일\) · 8/u], role: "summary" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(2);
    expect(presented.summary.map(claimDisplayText)).toEqual(["9월 평균 처리시간은 8일입니다."]);
  });

  it("GROUND-06 a conditional the sources never state is rejected; a stated condition is kept", async () => {
    const run = await runAnalyze([await sameContentPdf()]);
    const { grounded, presented } = run.enrich([
      { text: "프로세스 단계가 모두 완료되면 평균 처리시간이 8일에 도달합니다.", evidence: [/완료 단계/u, /목표는 8일/u], role: "insight" },
      { text: "긴급 건은 선처리 후 사후 승인할 수 있습니다.", evidence: [/긴급 건/u], role: "insight" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(1);
    expect(visibleTexts(presented).join("\n")).not.toMatch(/완료되면/u);
  });

  it("GROUND-07 a claim that turns a stated step into a skipped one, or predicts an unstated effect, is rejected", async () => {
    const run = await runAnalyze([await sameContentPdf()]);
    const { grounded, presented } = run.enrich([
      { text: "긴급 건 예외가 적용되면 사후 승인 단계가 생략됩니다.", evidence: [/긴급 건/u], role: "insight" },
      { text: "긴급 건은 선처리 후 사후 승인하므로 처리시간이 단축될 수 있습니다.", evidence: [/긴급 건/u], role: "insight" },
      { text: "긴급 건은 선처리한 뒤 사후에 승인할 수 있습니다.", evidence: [/긴급 건/u], role: "summary" },
    ]);
    expect(grounded.rejectedClaimCount).toBe(2);
    expect(visibleTexts(presented).join("\n")).not.toMatch(/생략|단축될 수/u);
    expect(presented.summary.map(claimDisplayText)).toEqual(["긴급 건은 선처리한 뒤 사후에 승인할 수 있습니다."]);
  });

  it("PROVIDER-01..03 invalid JSON, empty claims and all-rejected claims keep the deterministic result", async () => {
    const run = await runAnalyze([await sameContentPdf()]);
    const baseline = deterministic(run);
    expect(baseline.length).toBeGreaterThan(0);
    for (const payload of ["{not json", JSON.stringify({ claims: [] }), JSON.stringify({ claims: [
      { text: "처리시간을 50% 단축합니다.", role: "summary", confidence: "high", sources: [run.window.items[0].handle] },
    ] })]) {
      const { presented } = run.enrichRaw(payload);
      expect(presented.summary).toEqual([]);
      expect(presented.insights).toEqual([]);
      expect(visibleTexts(presented, run.metrics)).toEqual(baseline);
    }
  });

  it("FUZZ-01 seeded layout variations keep core coverage within one concept of the baseline", async () => {
    const baseline = coverage(windowTexts(await runAnalyze([await sameContentXlsx()])), SAME_MEANING).hit.length;
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seeded(seed);
      const shuffle = <T,>(values: T[]) => values.map((value) => ({ value, key: random() })).sort((a, b) => a.key - b.key).map(({ value }) => value);
      const rows = shuffle([
        ["목표", "프로젝트 목표는 처리시간을 20% 단축하는 것입니다."],
        ["기준", "현재 평균 처리시간은 10일이며 목표는 8일입니다."],
        ["기본 프로세스", "접수 → 검토 → 승인 → 완료"],
        ["예외", "긴급 건은 선처리 후 사후 승인할 수 있습니다."],
      ]);
      const blanks = Array.from({ length: Math.floor(random() * 3) }, () => [] as string[]);
      const swap = random() > 0.5;
      const header = swap ? ["내용", "항목"] : ["항목", "내용"];
      const body = rows.map((row) => (swap ? [row[1], row[0]] : row));
      const months = [["월", "평균 처리시간(일)"], ["8월", 9], ["9월", 8]];
      const variant = await xlsxFile(`fz${seed}`, `variant-${seed}.xlsx`, [
        { name: "개요", rows: [["처리시간 단축 프로젝트"], ...blanks, header, ...body] },
        { name: "월별", rows: random() > 0.5 ? months : [[], ...months] },
      ]);
      const hits = coverage(windowTexts(await runAnalyze([variant])), SAME_MEANING).hit.length;
      expect(baseline - hits, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
  });
});
