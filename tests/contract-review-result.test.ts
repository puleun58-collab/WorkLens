import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractReviewResult } from "../src/components/research/ContractReviewResult";
import type { SourceStatus } from "../src/lib/contract-review";
import type { ReviewFile } from "../src/lib/law-review-source";
import { reviewFileFixture, reviewResultFixture } from "./fixtures/contract-review-result";

function render(review = reviewResultFixture(), file?: ReviewFile) {
  const before = structuredClone({ review, file });
  const html = renderToStaticMarkup(createElement(ContractReviewResult, { review, file, onExpandSourcesChange: () => {} }));
  expect({ review, file }).toEqual(before);
  return html;
}

function contents(html: string, className: string) {
  return html.split(`class="${className}">`)[1]?.split("</p>")[0].replace(/<[^>]*>/gu, "");
}

describe("document review result presentation", () => {
  it("counts clauses with issues separately from issues and retains every original result", () => {
    const review = reviewResultFixture();
    const html = render(review);
    expect(html).toContain("<dt>쟁점 발견 조항</dt><dd>3개</dd>");
    expect(html).toContain("<dt>검토 쟁점</dt><dd>5건</dd>");
    expect(html.match(/class="contract-review-issue is-/gu)).toHaveLength(5);
    for (const clause of review.clauses) {
      expect(html).toContain(`${clause.number} ${clause.title}`);
      for (const issue of clause.issues) {
        expect(html).toContain(issue.point);
        expect(html).toContain(issue.suggestion);
        expect(html).toContain(issue.fact);
      }
    }
    const filtered = { ...review, clauses: review.clauses.filter((clause) => clause.issues.length) };
    expect(render(filtered)).toContain("<dt>쟁점 발견 조항</dt><dd>3개</dd>");
  });

  it("counts only issues with resolvable references and describes mixed remaining statuses without claiming absence", () => {
    const html = render();
    expect(html).toContain("<dt>관련 근거 확인</dt><dd>2/5건</dd>");
    expect(contents(html, "contract-review-summary-description")).toBe("5건의 쟁점 중 2건에서 관련 근거를 확인했습니다. 나머지 3건은 근거 확인이 완료되지 않았습니다.");
    expect(html).toContain("근거 미확인");
    expect(html).toContain("근거 조회 실패");
    expect(html).toContain("해당 근거 미조회");
    expect(html).toContain("근거 일부 확인");
    expect(html).toContain('data-status="partial"');
    expect(html).not.toContain('data-status="matched"');
  });

  it("deduplicates existing reference keys, counts articles within one law and distinct holdings within one case", () => {
    const html = render();
    expect(contents(html, "contract-review-meta contract-review-materials")).toBe("관련 자료 · 법령 조문 2건 · 판례 판시사항 2건");
    expect(html).toContain("같은 판례의 서로 다른 판시사항은 각각 집계합니다.");
    expect(html).not.toContain("참조되지 않은");
    expect(html).toContain("① 손해배상액을 예정할 수 있다.");
    expect(html).toContain("위약금 관련 판시사항");
    expect(html).toContain("계약 해지 관련 판시사항");
  });

  it("preserves server risk counts and the severity badge for each issue", () => {
    const review = reviewResultFixture();
    const html = render(review);
    const labels = { high: "높음", medium: "보통", low: "낮음" };
    for (const severity of ["high", "medium", "low"] as const) {
      expect(html).toContain(`data-severity="${severity}">${labels[severity]} <strong>${review.risk[severity]}</strong>건`);
    }
    const badges = [...html.matchAll(/class="[^"]*contract-review-severity[^"]*"[^>]*data-severity="([^"]+)"/gu)].map((match) => match[1]);
    expect(badges).toEqual(review.clauses.flatMap((clause) => clause.issues.map((issue) => issue.severity)));
  });

  it.each([
    ["failed", "근거 조회에 실패했습니다."],
    ["partial", "근거가 일부만 확인되어 추가 확인이 필요합니다."],
    ["not_searched", "해당 근거를 조회하지 않았습니다."],
    ["none", "근거 확인이 완료되지 않았습니다."],
  ] as const)("names homogeneous %s lookup states without promoting them to confirmed", (status: SourceStatus, explanation) => {
    const review = reviewResultFixture();
    const issue = { ...review.clauses[1].issues[0], laws: [], precedents: [], lawStatus: status, precedentStatus: status };
    review.clauses = [{ ...review.clauses[1], issues: [issue] }];
    const html = render(review);
    expect(html).toContain("<dt>관련 근거 확인</dt><dd>0/1건</dd>");
    expect(contents(html, "contract-review-summary-description")).toBe(`1건의 쟁점 중 0건에서 관련 근거를 확인했습니다. 나머지 1건은 ${explanation}`);
    expect(html).not.toContain('data-status="matched"');
  });

  it("keeps an incomplete lookup warning even when every issue has a reference", () => {
    const review = reviewResultFixture();
    review.clauses = [review.clauses[0]];
    const html = render(review);
    expect(html).toContain("<dt>관련 근거 확인</dt><dd>2/2건</dd>");
    expect(html).toContain("추가 확인 필요");
    expect(html).toContain("일부 법령·판례 출처 조회가 완료되지 않아 추가 확인이 필요합니다");
    expect(html).toContain('data-status="partial"');
    expect(contents(html, "contract-review-summary-description")).toBe("2건의 쟁점 중 2건에서 관련 근거를 확인했습니다.");
  });

  it("hides complete coverage processing counts while preserving scope and image limitations", () => {
    const html = render(reviewResultFixture(), reviewFileFixture("complete"));
    expect(html).toContain("<dt>검토 범위</dt><dd><strong>전체 검토</strong>");
    expect(html).not.toContain("10개 문단 중 10개");
    expect(html).not.toContain("전송 단위");
    expect(html).toContain("이미지 안의 글자는 읽지 않습니다.");
    expect(html).toContain("근거 미확인");
  });

  it("retains partial coverage counts, exclusions, reasons and the review scope warning", () => {
    const html = render(reviewResultFixture(), reviewFileFixture("partial"));
    expect(html).toContain("부분 검토");
    expect(html).toContain("10개 문단 중 6개 상세 검토");
    expect(html).toContain("상세 미검토 3개");
    expect(html).toContain("조항 문장이 없는 1개 문단");
    expect(html).toContain("분량 제한으로 일부 문단을 상세 검토하지 못했습니다.");
    expect(html).toContain("문서의 일부만 검토했습니다. 결과는 검토한 범위 기준입니다");
    expect(html).toContain("검토한 범위 요약");
    expect(html).not.toContain("전송 단위");
  });

  it("shows zero counts without implying that a review with no issues proves legal safety", () => {
    const review = reviewResultFixture();
    review.clauses = [];
    const html = render(review);
    for (const [label, value] of [["쟁점 발견 조항", "0개"], ["검토 쟁점", "0건"], ["관련 근거 확인", "0/0건"]]) {
      expect(html).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
    }
    expect(html).toContain("쟁점을 찾지 못했다는 것이 법적 위험이 없다는 뜻은 아닙니다.");
    expect(html).not.toContain("contract-review-materials");
  });
});
