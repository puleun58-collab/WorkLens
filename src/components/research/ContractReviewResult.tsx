"use client";

import type { ContractReview, ReviewedIssue, SourceStatus } from "@/lib/contract-review";

const SEVERITY_LABEL = { high: "높음", medium: "보통", low: "낮음" } as const;
const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";

function formatDate(value?: string): string | undefined {
  return value && /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6)}` : value;
}

function statusNote(kind: "법령" | "판례", status: SourceStatus): string | null {
  if (status === "failed") return `${kind} 검색에 실패했습니다. 조항 검토 내용은 그대로 참고할 수 있습니다.`;
  if (status === "none") {
    return kind === "판례"
      ? "현재 검색 범위에서 직접 관련성이 높은 판례를 확인하지 못했습니다."
      : "현재 검색 범위에서 직접 관련된 조문을 확인하지 못했습니다.";
  }
  return null;
}

/**
 * 문서 검토 result: clause → issue → statutes → precedents. Every statute
 * title, article text, case number, court and date shown here came from a
 * 법제처 search result; a citation already shown under an earlier clause is
 * named again, not repeated in full.
 */
export function ContractReviewResult({ review }: { review: ContractReview }) {
  const shownLaws = new Set<string>();
  const shownPrecedents = new Set<string>();
  const { document, risk } = review;

  const issueBody = (issue: ReviewedIssue) => {
    const laws = issue.laws.map((key) => review.laws[key]).filter(Boolean);
    const precedents = issue.precedents.map((key) => review.precedents[key]).filter(Boolean);
    const lawNote = laws.length ? null : statusNote("법령", issue.lawStatus);
    const precedentNote = precedents.length ? null : statusNote("판례", issue.precedentStatus);
    return <>
      <dl className="contract-review-facts">
        <dt>원문</dt><dd>{issue.fact}</dd>
        <dt>검토 포인트</dt><dd>{issue.point}</dd>
      </dl>
      {(laws.length > 0 || lawNote) && <div className="contract-review-refs">
        <h5>관련 법령</h5>
        {lawNote && <p className="law-search-note">{lawNote}</p>}
        {laws.length > 0 && <ul>{laws.map((law) => {
          const repeated = shownLaws.has(law.key);
          shownLaws.add(law.key);
          const name = `${law.law} ${law.jo}${law.title ? ` (${law.title})` : ""}`;
          return <li key={law.key}>
            {repeated ? <span>{name} — 위 조항에서 확인</span> : <details>
              <summary>{name}{law.effectiveDate ? <span className="contract-review-meta"> 시행 {formatDate(law.effectiveDate)}</span> : null}</summary>
              <pre className="legal-analysis-lines">{law.excerpt}</pre>
            </details>}
            {!repeated && law.condition && <p className="contract-review-condition">{law.condition}</p>}
          </li>;
        })}</ul>}
      </div>}
      {(precedents.length > 0 || precedentNote) && <div className="contract-review-refs">
        <h5>관련 판례</h5>
        {precedentNote && <p className="law-search-note">{precedentNote}</p>}
        {precedents.length > 0 && <ul>{precedents.map((precedent) => {
          const repeated = shownPrecedents.has(precedent.key);
          shownPrecedents.add(precedent.key);
          const heading = [precedent.court, precedent.caseNumber, formatDate(precedent.date)].filter(Boolean).join(" · ");
          return <li key={precedent.key}>
            <strong>{precedent.title ?? precedent.caseNumber ?? "판례"}</strong>
            {heading && <span className="contract-review-meta"> {heading}</span>}
            {repeated ? <p className="contract-review-meta">위 조항에서 확인한 판례입니다.</p>
              : <p className="contract-review-holding">{precedent.holding}<span className="contract-review-meta"> (판시사항 기준, 판결 전문은 검토하지 않았습니다.)</span></p>}
          </li>;
        })}</ul>}
      </div>}
    </>;
  };

  return <div className="legal-analysis-output contract-review" data-task="document_review" data-document-type={document.type}>
    <div className="legal-analysis-section">
      <h3>문서 개요</h3>
      <dl className="contract-review-facts">
        <dt>문서 유형</dt>
        <dd>{document.label}{document.confidence !== "high" && document.type !== "unknown" ? " (추정)" : ""}</dd>
        <dt>당사자 관계</dt><dd>{document.relationshipLabel}</dd>
        <dt>검토 필요 조항 위험도</dt>
        <dd>{risk.level} <span className="contract-review-meta">높음 {risk.high} · 보통 {risk.medium} · 낮음 {risk.low}건, 조항 내용 기준이며 검색된 법령·판례 수와 무관합니다.</span></dd>
      </dl>
      {review.facts.length > 0 && <ul className="contract-review-keyfacts">
        {review.facts.map((fact) => <li key={`${fact.clause}-${fact.value}`}><span>{fact.label}</span> {fact.value}{fact.clause ? <span className="contract-review-meta"> ({fact.clause})</span> : null}</li>)}
      </ul>}
    </div>
    {review.clauses.length === 0 && <p className="law-search-note">검토가 필요한 조항을 찾지 못했습니다.</p>}
    {review.clauses.map((clause, index) => <section key={`${clause.number ?? index}`} className="legal-analysis-section contract-review-clause">
      <h3>{clause.number ?? `조항 ${index + 1}`}{clause.title ? ` ${clause.title}` : ""}</h3>
      {clause.issues.map((issue) => <div key={issue.id} className={`contract-review-issue is-${issue.severity}`}>
        <h4>{issue.label} <span className="contract-review-meta">검토 우선순위 {SEVERITY_LABEL[issue.severity]}</span></h4>
        {issueBody(issue)}
      </div>)}
    </section>)}
    <p className="legal-analysis-note">데이터 출처: 법제처 국가법령정보센터 OPEN API. {RESULT_NOTE}</p>
  </div>;
}
