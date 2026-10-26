import { describe, expect, it } from "vitest";
import { articleTitleDisplay, articleTitleDisplayLines, resolveLawArticleTarget } from "@/lib/law-article-target";

const META = ["법령명: 근로기준법", "", "공포일: 20260407", "시행일: 20261008", ""];

describe("law article title dedup (detail view only)", () => {
  it("merges plain + parenthesized headings into one unified title and keeps metadata and body", () => {
    const lines = [...META, "제25조 우선 재고용 등", "제25조(우선 재고용 등)", "① 본문 하나", "② 본문 둘"];
    const display = articleTitleDisplayLines(lines, "제25조");
    expect(display.title).toBe("제25조(우선 재고용 등)");
    expect(display.deduped).toBe(true);
    expect(display.droppedIndices).toEqual([5, 6]);
    expect(display.bodyLines).toEqual([...META, "① 본문 하나", "② 본문 둘"]);
  });

  it("handles a branch-number article and never drops a body citation of another 조", () => {
    const lines = [
      "제43조의2 체불사업주 명단 공개", "제43조의2(체불사업주 명단 공개)",
      "① 제36조에 따라 지급하지 아니한 사업주",
      "② 제43조에 따른 체불사업주 명단을 공개한다.",
    ];
    const display = articleTitleDisplayLines(lines, "제43조의2");
    expect(display.title).toBe("제43조의2(체불사업주 명단 공개)");
    expect(display.bodyLines).toEqual([
      "① 제36조에 따라 지급하지 아니한 사업주",
      "② 제43조에 따른 체불사업주 명단을 공개한다.",
    ]);
  });

  it("drops a single parenthesized or plain heading and renders it in parenthesized form", () => {
    const paren = articleTitleDisplayLines(["제1조(목적)", "① 이 법은 근로조건의 기준을 정함을 목적으로 한다."], "제1조");
    expect(paren.title).toBe("제1조(목적)");
    expect(paren.bodyLines).toEqual(["① 이 법은 근로조건의 기준을 정함을 목적으로 한다."]);
    const plain = articleTitleDisplayLines(["제1조 목적", "① 이 법은 근로조건의 기준을 정함을 목적으로 한다."], "제1조");
    expect(plain.title).toBe("제1조(목적)");
    expect(plain.bodyLines).toEqual(["① 이 법은 근로조건의 기준을 정함을 목적으로 한다."]);
  });

  it("merges a long plain + parenthesized title pair into one heading", () => {
    const longTitle = "전자상거래 등에서의 소비자보호에 관한 법률의 적용 범위";
    const display = articleTitleDisplayLines(
      [`제3조 ${longTitle}`, `제3조(${longTitle})`, "① 본문"], "제3조");
    expect(display.title).toBe(`제3조(${longTitle})`);
    expect(display.bodyLines).toEqual(["① 본문"]);
  });

  it("keeps a title-less deleted article under its bare 조 number and keeps the deletion note", () => {
    const display = articleTitleDisplayLines(["제35조", "삭제 <2019.1.15>"], "제35조");
    expect(display.title).toBe("제35조");
    expect(display.deduped).toBe(true);
    expect(display.bodyLines).toEqual(["삭제 <2019.1.15>"]);
    const bareBare = articleTitleDisplayLines(["제35조", "제35조", "삭제 <2019.1.15>"], "제35조");
    expect(bareBare.title).toBe("제35조");
    expect(bareBare.bodyLines).toEqual(["삭제 <2019.1.15>"]);
  });

  it("drops a bare 조 line followed by a parenthesized title", () => {
    const display = articleTitleDisplayLines(["제35조", "제35조(삭제 조문)", "① 본문"], "제35조");
    expect(display.title).toBe("제35조(삭제 조문)");
    expect(display.bodyLines).toEqual(["① 본문"]);
  });

  it("keeps the original when the two heading titles disagree, instead of picking one", () => {
    const lines = ["제25조 우선 재고용 등", "제25조(다른 제목)", "① 본문"];
    const display = articleTitleDisplayLines(lines, "제25조");
    expect(display.deduped).toBe(false);
    expect(display.mismatch).toBe("title-mismatch");
    expect(display.title).toBe("제25조");
    expect(display.bodyLines).toEqual(lines);
  });

  it("keeps the original when the second heading belongs to another 조", () => {
    const lines = ["제25조", "제26조(다른 조)", "① 본문"];
    const display = articleTitleDisplayLines(lines, "제25조");
    expect(display.deduped).toBe(false);
    expect(display.mismatch).toBe("next-jo-mismatch");
    expect(display.bodyLines).toEqual(lines);
  });

  it("does not treat a body line that starts with the 조 number as a heading", () => {
    const hang = articleTitleDisplayLines(["제25조 ① 본문이 바로 이어지는 경우", "② 둘"], "제25조");
    expect(hang.deduped).toBe(false);
    expect(hang.mismatch).toBe("not-title-line");
    const ho = articleTitleDisplayLines(["제25조 1. 호처럼 보이는 본문", "② 둘"], "제25조");
    expect(ho.deduped).toBe(false);
  });

  it("normalizes whitespace when comparing plain and parenthesized titles", () => {
    const display = articleTitleDisplayLines(
      ["제25조   우선  재고용 등", "제25조(우선 재고용 등)", "① 본문"], "제25조");
    expect(display.deduped).toBe(true);
    expect(display.title).toBe("제25조(우선 재고용 등)");
  });

  it("leaves text without a heading line untouched", () => {
    const lines = ["① 제목 행이 없는 본문", "② 둘"];
    const display = articleTitleDisplayLines(lines, "제25조");
    expect(display.deduped).toBe(false);
    expect(display.mismatch).toBe("no-jo-line");
    expect(display.bodyLines).toEqual(lines);
  });

  it("text form: full MCP text keeps metadata, drops headings, unifies the title", () => {
    const text = [...META, "제25조 우선 재고용 등", "제25조(우선 재고용 등)", "① 본문 하나", "② 본문 둘"].join("\n");
    const display = articleTitleDisplay(text, "제25조");
    expect(display.title).toBe("제25조(우선 재고용 등)");
    // lawDisplayText formats labelled compact dates; metadata lines otherwise stay as-is.
    expect(display.body).toBe([
      "법령명: 근로기준법", "", "공포일: 2026.04.07", "시행일: 2026.10.08", "",
      "① 본문 하나", "② 본문 둘",
    ].join("\n"));
  });
});

describe("law article target resolution after title dedup", () => {
  const ARTICLE_60 = [
    "법령명: 근로기준법", "",
    "제60조 연차 유급휴가", "제60조(연차 유급휴가)",
    "① 항하나",
    "⑥ 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
    "1. 호하나", "2. 호둘", "3. 호셋",
    "⑦ 항일곱",
  ].join("\n");

  it("highlights the exact 항/호 body lines in the deduped body, never a heading line", () => {
    const resolved = resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 6, ho: 3 });
    expect(resolved.fallback).toBe(false);
    if (!resolved.fallback) {
      expect(resolved.title).toBe("제60조(연차 유급휴가)");
      expect(resolved.shownLines).not.toContain("제60조 연차 유급휴가");
      expect(resolved.shownLines).not.toContain("제60조(연차 유급휴가)");
      expect([...resolved.targetIndices].map((index) => resolved.shownLines[index])).toEqual([
        "⑥ 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
        "3. 호셋",
      ]);
    }
  });

  it("fallback shows the deduped whole article with the unified title", () => {
    const resolved = resolveLawArticleTarget(ARTICLE_60, "제60조", { hang: 9 });
    expect(resolved.fallback).toBe(true);
    expect(resolved.title).toBe("제60조(연차 유급휴가)");
    expect(resolved.shownLines).toEqual([
      "법령명: 근로기준법", "",
      "① 항하나",
      "⑥ 다음 각 호의 어느 하나에 해당하는 기간은 출근한 것으로 본다.",
      "1. 호하나", "2. 호둘", "3. 호셋",
      "⑦ 항일곱",
    ]);
  });

  it("a deleted article falls back with the bare 조 title and the deletion note intact", () => {
    const resolved = resolveLawArticleTarget("제35조\n삭제 <2019.1.15>", "제35조", { hang: 1 });
    expect(resolved.fallback).toBe(true);
    expect(resolved.title).toBe("제35조");
    expect(resolved.shownLines).toEqual(["삭제 <2019.1.15>"]);
  });

  it("mismatched headings stay in the display while 항 movement still lands on the body", () => {
    const text = "제25조 제목 갑\n제25조(제목 을)\n① 본문 하나\n② 본문 둘";
    const resolved = resolveLawArticleTarget(text, "제25조", { hang: 2 });
    expect(resolved.fallback).toBe(false);
    if (!resolved.fallback) {
      expect(resolved.shownLines).toEqual(["제25조 제목 갑", "제25조(제목 을)", "① 본문 하나", "② 본문 둘"]);
      expect([...resolved.targetIndices].map((index) => resolved.shownLines[index])).toEqual(["② 본문 둘"]);
    }
  });
});
