"use client";
import { useEffect, useRef } from "react";

import type { ContractReview, ReviewedIssue } from "@/lib/contract-review";
import type { ReviewCoverage, ReviewFile } from "@/lib/law-review-source";
import { STATUS_TITLE, type ResearchStatus } from "@/lib/research-status";
import { SourceToggleSummary } from "./SourceToggleSummary";

const SEVERITY_LABEL = { high: "높음", medium: "보통", low: "낮음" } as const;
const RESULT_NOTE = "판례는 판시사항 기준이며 판결 전문은 포함되지 않습니다. 법적 판단은 원문 및 전문가 검토가 필요할 수 있습니다.";
const COVERAGE_LABEL: Record<ReviewCoverage["status"], string> = { complete: "전체 검토", partial: "부분 검토", excluded: "검토 제외" };
const IMAGE_NOTE = "이미지 안의 글자는 읽지 않습니다.";
const PLACES_SHOWN = 3;

/** A review location is historical text, never an original-document link. Reject mismatched segment/source provenance. */
function placesOf(file: ReviewFile | undefined, segments: readonly number[] | undefined, besides: readonly number[] = []): string | undefined {
  if (!file || !segments?.length) return undefined;
  const label = (index: number) => {
    const source = file.sources[index];
    if (!Number.isInteger(index) || !source || source.fileId !== file.fileId
      || !file.document.version || source.documentId !== file.document.id
      || source.documentVersion !== file.document.version || source.locator?.kind !== file.document.kind) return undefined;
    return file.document.segments[index]?.location;
  };
  const shown = new Set(besides.map(label));
  const places = [...new Set(segments.map(label).filter((place): place is string => Boolean(place) && !shown.has(place)))];
  if (!places.length) return undefined;
  return places.length > PLACES_SHOWN ? `${places.slice(0, PLACES_SHOWN).join(" · ")} 외 ${places.length - PLACES_SHOWN}곳` : places.join(" · ");
}

function FileCoverage({ file }: { file: ReviewFile }) {
  const { coverage } = file;
  return <>
    <dt>검토 범위</dt>
    <dd>
      <strong>{COVERAGE_LABEL[coverage.status]}</strong> · {coverage.total.toLocaleString("ko-KR")}개 {coverage.unit} 중 {coverage.reviewed.toLocaleString("ko-KR")}개 {coverage.status === "partial" ? "상세 검토" : "검토"}
      {coverage.unreviewed > 0 && ` · ${coverage.status === "partial" ? "상세 미검토" : "미검토"} ${coverage.unreviewed.toLocaleString("ko-KR")}개`}
      {(coverage.reasons.length > 0 || coverage.excluded > 0 || file.imagesUnread) && <ul className="contract-review-coverage">
        {coverage.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        {coverage.excluded > 0 && <li>조항 문장이 없는 {coverage.excluded.toLocaleString("ko-KR")}개 {coverage.unit}(숫자·코드 위주)은 검토 대상이 아니어서 제외했습니다.</li>}
        {file.imagesUnread && <li>{IMAGE_NOTE}</li>}
      </ul>}
    </dd>
  </>;
}

/** A workspace file with no reviewable text: reported as not reviewed, never as "no issues". */
export function FileReviewExcluded({ file }: { file: ReviewFile }) {
  return <div className="legal-analysis-missing contract-review" role="status" data-coverage="excluded">
    <header className="research-overview">
      <span className="research-eyebrow">문서 검토</span>
      <h3 className="legal-analysis-title">검토할 수 있는 내용을 확인하지 못했습니다</h3>
      <p className="research-meta">검토 문서: {file.document.name}</p>
      <p>{file.coverage.note}</p>
      {file.imagesUnread && <p className="research-caution">{IMAGE_NOTE}</p>}
      <p className="research-caution">위험 항목이 없다는 뜻이 아니라 이 문서를 검토하지 못했다는 뜻입니다.</p>
    </header>
  </div>;
}

function formatDate(value?: string): string | undefined {
  return value && /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6)}` : value;
}

/** Whole-block focus: a brighter tint on arrival, a settled tint, then a fade back to the default look. */
const FOCUS_CLASSES = ["is-focused", "is-focus-fresh", "is-focus-leaving"];
const FOCUS_FRESH_MS = 450;
const FOCUS_SETTLED_MS = 1750;
const FOCUS_FADE_MS = 350;

export function ContractReviewResult({ review, file }: { review: ContractReview; file?: ReviewFile }) {
  const activeDetail = useRef<HTMLElement | null>(null);
  const focusTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    window.clearTimeout(focusTimer.current);
    activeDetail.current?.classList.remove(...FOCUS_CLASSES);
  }, []);

  function showEvidence(anchor: string) {
    const target = window.document.getElementById(anchor);
    if (!target) return;
    window.clearTimeout(focusTimer.current);
    activeDetail.current?.classList.remove(...FOCUS_CLASSES);
    target.classList.remove(...FOCUS_CLASSES);
    // A repeat click restarts from the fresh tint instead of continuing the running fade.
    void target.offsetWidth;
    target.classList.add("is-focused", "is-focus-fresh");
    activeDetail.current = target;
    target.scrollIntoView({ behavior: "instant", block: "start" });
    focusTimer.current = window.setTimeout(() => {
      target.classList.remove("is-focus-fresh");
      focusTimer.current = window.setTimeout(() => {
        target.classList.add("is-focus-leaving");
        focusTimer.current = window.setTimeout(() => {
          target.classList.remove(...FOCUS_CLASSES);
          activeDetail.current = null;
          focusTimer.current = undefined;
        }, FOCUS_FADE_MS);
      }, FOCUS_SETTLED_MS);
    }, FOCUS_FRESH_MS);
  }

  const shownLaws = new Set<string>();
  const shownPrecedents = new Set<string>();
  const { document, risk } = review;
  const issues = review.clauses.flatMap((clause) => clause.issues);
  const grounded = issues.filter((issue) =>
    issue.laws.some((key) => review.laws[key]) || issue.precedents.some((key) => review.precedents[key])).length;
  const status: ResearchStatus = !issues.length ? "none"
    : grounded === issues.length ? "matched"
    : grounded ? "partial"
    : review.stats.excludedPrecedents > 0 ? "weak" : "none";
  const lawCount = new Set(issues.flatMap((issue) => issue.laws.filter((key) => review.laws[key]))).size;
  const precedentCount = new Set(issues.flatMap((issue) => issue.precedents.filter((key) => review.precedents[key]))).size;
  const lookupIncomplete = issues.some((issue) => issue.lawStatus === "failed" || issue.lawStatus === "partial"
    || issue.precedentStatus === "failed" || issue.precedentStatus === "partial");

  const issueBody = (issue: ReviewedIssue, anchor: string, clauseSegments?: readonly number[]) => {
    const laws = [...new Set(issue.laws)].map((key) => review.laws[key]).filter(Boolean);
    const precedents = [...new Set(issue.precedents)].map((key) => review.precedents[key]).filter(Boolean);
    const place = placesOf(file, issue.segments);
    // The rest of the clause (a heading, the next paragraph or page) stays visible as related places.
    const related = placesOf(file, clauseSegments, issue.segments);
    return <dl className="contract-review-facts contract-review-issue-facts">
      {place && <><dt>검토 당시 위치</dt><dd className="contract-review-place">{place}{related && <span className="contract-review-meta"> · 같은 조항 {related}</span>}</dd></>}
      <dt>검토 원문</dt><dd>{issue.fact}</dd>
      <dt>검토 결과</dt><dd>{issue.point}</dd>
      <dt>우선순위</dt><dd>{SEVERITY_LABEL[issue.severity]}</dd>
      {issue.suggestion && <><dt>수정 제안</dt><dd>{issue.suggestion}</dd></>}
      <dt>확인한 근거</dt>
      <dd>{laws.length + precedents.length > 0
        ? <>{laws.map((law) => `${law.law} ${law.jo}`).concat(precedents.map((precedent) =>
          precedent.title ?? precedent.caseNumber ?? "판례")).join(" · ")} <button type="button" className="law-search-link" aria-controls={anchor} onClick={() => showEvidence(anchor)}>상세 근거 보기</button></>
        : issue.lawStatus === "failed" || issue.precedentStatus === "failed"
          ? "직접 근거 확인이 완료되지 않았습니다."
          : "확인된 직접 근거 없음"}</dd>
    </dl>;
  };

  const issueEvidence = (issue: ReviewedIssue) => {
    const laws = [...new Set(issue.laws)].map((key) => review.laws[key]).filter(Boolean);
    const precedents = [...new Set(issue.precedents)].map((key) => review.precedents[key]).filter(Boolean);
    return <>
      {laws.length > 0 && <details className="law-detail-source contract-review-refs">
        <SourceToggleSummary label={`관련 법령 ${laws.length}건 보기`} openLabel="관련 법령 접기" />
        <ul>{laws.map((law) => {
          const repeated = shownLaws.has(law.key);
          shownLaws.add(law.key);
          const name = `${law.law} ${law.jo}${law.title ? ` (${law.title})` : ""}`;
          return <li key={law.key}>
            <strong>{name}</strong>
            {law.effectiveDate && <span className="contract-review-meta">시행 {formatDate(law.effectiveDate)}</span>}
            {repeated ? <p className="contract-review-meta">앞선 쟁점에서 제시한 근거입니다.</p> : <>
              {law.condition && <p className="contract-review-condition">{law.condition}</p>}
              {law.excerpt && <pre className="legal-analysis-lines">{law.excerpt}</pre>}
            </>}
          </li>;
        })}</ul>
      </details>}
      {precedents.length > 0 && <details className="law-detail-source contract-review-refs">
        <SourceToggleSummary label={`관련 판례 ${precedents.length}건 보기`} openLabel="관련 판례 접기" />
        <ul>{precedents.map((precedent) => {
          const repeated = shownPrecedents.has(precedent.key);
          shownPrecedents.add(precedent.key);
          const metadata = [precedent.court, precedent.caseNumber, formatDate(precedent.date)].filter(Boolean).join(" · ");
          return <li key={precedent.key}>
            <strong>{precedent.title ?? precedent.caseNumber ?? "판례"}</strong>
            {metadata && <span className="contract-review-meta">{metadata}</span>}
            {repeated ? <p className="contract-review-meta">앞선 쟁점에서 제시한 근거입니다.</p>
              : <p className="contract-review-holding">{precedent.holding}</p>}
          </li>;
        })}</ul>
      </details>}
    </>;
  };

  const partial = file?.coverage.status === "partial";
  return <div className="legal-analysis-output contract-review" data-task="document_review" data-document-type={document.type} data-coverage={file?.coverage.status}>
    <header className="research-overview">
      <span className="research-eyebrow">문서 검토</span>
      <h3 className="legal-analysis-title" data-status={status}>{issues.length ? STATUS_TITLE[status] : partial ? "검토한 범위에서 쟁점을 찾지 못했습니다" : "검토할 쟁점을 찾지 못했습니다"}</h3>
      {file && <p className="research-meta contract-review-file">검토 문서: {file.document.name}</p>}
      {file && <p className="research-meta contract-review-preview-note">원본 파일 미리보기는 제공하지 않습니다. 아래 위치는 텍스트 안내이며 원본의 해당 위치로 이동하지 않습니다. PDF 도구는 별도의 작업 공간입니다.</p>}
      {partial && <p className="research-caution">문서의 일부만 검토했습니다. 아래 결과는 검토된 범위에서 확인된 항목입니다.</p>}
      {lookupIncomplete && <p className="research-caution">일부 법령·판례 출처 조회가 완료되지 않았습니다. 근거를 확인하지 못한 항목도 쟁점이 없다는 뜻은 아닙니다.</p>}
      {file && document.type === "unknown" && <p className="research-caution">현재 문서에서 법령 문서 검토에 필요한 계약·규정 성격을 충분히 확인하지 못했습니다.</p>}
      <p className="research-caution">{issues.length
        ? "검토 결과는 관련 쟁점을 확인하기 위한 자료이며, 구체적인 사건의 법적 결론을 의미하지 않습니다."
        : "검토할 쟁점을 찾지 못했지만 문서에 법적 위험이 없다는 뜻은 아닙니다."}</p>
    </header>
    <section className="legal-analysis-section contract-review-overview">
      <h3>문서 개요</h3>
      <dl className="contract-review-facts">
        <dt>문서 유형</dt>
        <dd>{document.label}{document.confidence !== "high" && document.type !== "unknown" ? " (추정)" : ""}</dd>
        <dt>당사자 관계</dt><dd>{document.relationshipLabel}</dd>
        <dt>검토 필요 조항 위험도</dt>
        <dd>{risk.level} <span className="contract-review-meta">높음 {risk.high} · 보통 {risk.medium} · 낮음 {risk.low}건 (조항 내용 기준)</span></dd>
        {file && <FileCoverage file={file} />}
      </dl>
      {review.facts.length > 0 && <ul className="contract-review-keyfacts">
        {review.facts.map((fact) => <li key={`${fact.clause}-${fact.value}`}><span>{fact.label}</span> {fact.value}{fact.clause ? <span className="contract-review-meta"> ({fact.clause})</span> : null}</li>)}
      </ul>}
    </section>
    <section className="legal-analysis-section contract-review-summary">
      <h3>{partial ? "검토한 범위 요약" : "전체 검토 요약"}</h3>
      <p>검토 조항 {review.clauses.length}개 · 높은 우선순위 {risk.high}건 · 보통 {risk.medium}건 · 낮음 {risk.low}건
        <span className="contract-review-meta"> · 관련 근거 확인 {grounded}/{issues.length}건
          {lawCount + precedentCount > 0 && ` (법령 ${lawCount}건 · 판례 ${precedentCount}건)`}</span>
      </p>
    </section>
    <section className="legal-analysis-section contract-review-results">
      <h3>조항별 검토 결과</h3>
      {review.clauses.length === 0 && <p className="law-search-note">검토할 쟁점을 찾지 못했습니다.</p>}
      {review.clauses.map((clause, index) => {
        const clausePlace = placesOf(file, clause.segments);
        return <section key={`${clause.number ?? index}`} className="legal-analysis-section contract-review-clause">
          <h4>{clause.number ?? clause.title ?? `검토 항목 ${index + 1}`}{clause.number && clause.title ? ` ${clause.title}` : ""}</h4>
          {clausePlace && <p className="contract-review-clause-place">검토 당시 조항 위치: {clausePlace}</p>}
          {clause.issues.map((issue, issueIndex) => <div key={issue.id} className={`contract-review-issue is-${issue.severity}`}>
            <h5>{issue.label}</h5>
            {issueBody(issue, `contract-review-evidence-${index}-${issueIndex}`, clause.segments)}
          </div>)}
        </section>;
      })}
    </section>
    {lawCount + precedentCount > 0 && <section className="legal-analysis-section contract-review-details">
      <h3>상세 근거</h3>
      {review.clauses.flatMap((clause, clauseIndex) => clause.issues.map((issue, issueIndex) => {
        if (!issue.laws.some((key) => review.laws[key]) && !issue.precedents.some((key) => review.precedents[key])) return null;
        return <div key={`${clauseIndex}-${issueIndex}`} id={`contract-review-evidence-${clauseIndex}-${issueIndex}`} className="contract-review-detail">
          <h4>{clause.number ?? clause.title ?? `검토 항목 ${clauseIndex + 1}`}{clause.number && clause.title ? ` ${clause.title}` : ""} · {issue.label}</h4>
          {issueEvidence(issue)}
        </div>;
      }))}
    </section>}
    <p className="legal-analysis-note">법령·판례 출처: 국가법령정보센터(법제처). {RESULT_NOTE}</p>
  </div>;
}
