"use client";

import { useState, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import type { SourceRef } from "@/domain/document";
import {
  SUPPLEMENT_DOC_TYPE_LABELS,
  SUPPLEMENT_SEVERITY_LABELS,
  SUPPLEMENT_SHEET_STATUS_LABELS,
  type SupplementResult,
  type SupplementSeverity,
} from "@/domain/supplement";
import "./supplement.css";

const SEVERITIES: readonly SupplementSeverity[] = ["critical", "warning", "suggestion"];

/**
 * 보완 result body. Findings read top-down by importance; the questions a
 * reader is likely to ask are collected once, and the analysed range is
 * always stated so an empty result is never mistaken for a complete one.
 */
export function SupplementResults({ result, fileNames, renderSource }: {
  result: SupplementResult;
  fileNames: Map<string, string>;
  renderSource: (sources: readonly SourceRef[], context: { issue: string; recommendation: string }) => ReactNode;
}) {
  const [filter, setFilter] = useState<"all" | SupplementSeverity>("all");
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, result.findings.filter((finding) => finding.severity === severity).length])) as Record<SupplementSeverity, number>;
  const visible = filter === "all" ? result.findings : result.findings.filter((finding) => finding.severity === filter);
  const complete = result.coverage.every((entry) => entry.complete);
  // Deliberately excluded sheets are disclosed; the analysis is complete but not "전체".
  const partialByDesign = complete && result.coverage.some((entry) => entry.sheets?.some((sheet) => sheet.status === "structure"));
  const multipleFiles = result.files.length > 1;

  return (
    <div className="result-sections supplement-results">
      <section className="supplement-overview" aria-label="보완 요약">
        <div className="check-filters-compact supplement-filters" role="group" aria-label="보완 중요도 필터">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>전체 <b>{result.findings.length}</b></button>
          {SEVERITIES.map((severity) => (
            <button key={severity} type="button" data-empty={counts[severity] === 0} aria-pressed={filter === severity} onClick={() => setFilter(severity)}>
              <i className={`severity-mark ${severity}`} aria-hidden="true" />{SUPPLEMENT_SEVERITY_LABELS[severity]} <b>{counts[severity]}</b>
            </button>
          ))}
        </div>
        <dl className="supplement-meta">
          <div>
            <dt>자료 유형</dt>
            <dd>{result.files.map((file) => multipleFiles ? `${fileNames.get(file.fileId) ?? file.fileName} · ${SUPPLEMENT_DOC_TYPE_LABELS[file.docType]}` : SUPPLEMENT_DOC_TYPE_LABELS[file.docType]).join(" / ")}</dd>
          </div>
          <div>
            <dt>분석 범위</dt>
            <dd>
              <span className={complete ? "supplement-coverage-state" : "supplement-coverage-state limited"}>{!complete ? "일부 분석 제한" : partialByDesign ? "분석 완료" : "전체 분석 완료"}</span>
              <ul className="supplement-coverage">
                {result.coverage.map((entry) => (
                  <li key={entry.fileId}>
                    <span className="supplement-coverage-count">{multipleFiles ? `${fileNames.get(entry.fileId) ?? entry.fileName} · ` : ""}{entry.kind.toUpperCase()} {entry.analyzed} / {entry.total} {entry.unit}</span>
                    {entry.sheets ? (
                      <small>{(["detailed", "limited", "structure", "failed"] as const)
                        .map((status) => [status, entry.sheets!.filter((sheet) => sheet.status === status).length] as const)
                        .filter(([, count]) => count > 0)
                        .map(([status, count]) => `${SUPPLEMENT_SHEET_STATUS_LABELS[status]} ${count}`)
                        .join(" · ")}</small>
                    ) : null}
                    {entry.notes.map((note) => <small key={note}>{note}</small>)}
                    {entry.sheets ? (
                      <details className="supplement-sheets">
                        <summary>시트별 처리 상태</summary>
                        <ul>
                          {entry.sheets.map((sheet) => (
                            <li key={sheet.name}>
                              <span className="supplement-sheet-name">{sheet.name}</span>
                              <span>{SUPPLEMENT_SHEET_STATUS_LABELS[sheet.status]}</span>
                              <small>{[sheet.role, sheet.hidden ? "숨김" : "", `${sheet.rows.toLocaleString("ko-KR")}행`, sheet.formulas ? `수식 ${sheet.formulas.toLocaleString("ko-KR")}` : "", sheet.note ?? ""].filter(Boolean).join(" · ")}</small>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
        {result.resolvedCount > 0 ? (
          <p className="supplement-note">다른 위치에서 설명을 확인한 후보 {result.resolvedCount}건은 결과에서 제외했습니다.</p>
        ) : null}
        {result.semanticReview === "partial" ? (
          <p className="supplement-note">일부 항목은 의미 기반 재확인을 마치지 못했습니다. 다른 표현으로 설명된 내용이 있을 수 있습니다.</p>
        ) : null}
      </section>

      {result.questions.length > 0 ? (
        <section className="supplement-questions" aria-labelledby="supplement-questions-heading">
          <h3 id="supplement-questions-heading">상사가 물어보기 전에</h3>
          <ol>{result.questions.map((question) => <li key={question}>{question}</li>)}</ol>
        </section>
      ) : null}

      {result.findings.length === 0 ? (
        <div className="status-panel success result-clear supplement-clear" role="status">
          <span className="status-panel-icon" aria-hidden="true"><CircleCheck size={18} fill="currentColor" stroke="white" strokeWidth={2.2} /></span>
          <strong>중요한 보완 항목을 확인하지 못했습니다.</strong>
          <p>{!complete
            ? "읽은 범위에서는 추가할 항목을 찾지 못했습니다. 읽지 못한 영역은 판단에서 제외했습니다."
            : partialByDesign
              ? "상세 분석한 시트에서는 추가할 항목을 찾지 못했습니다. 구조만 확인한 시트는 판단에서 제외했습니다."
              : "비교 기준, 원인, 영향, 대응, 담당, 일정, 결론 근거를 점검한 범위에서 추가할 항목을 찾지 못했습니다."}</p>
        </div>
      ) : (
        <section className="supplement-list" aria-label="보완 항목">
          {visible.map((finding) => (
            <article key={finding.id} className={`supplement-item check-issue severity-${finding.severity}`}>
              <header className="supplement-item-head">
                <span className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{SUPPLEMENT_SEVERITY_LABELS[finding.severity]}</span>
                <h3>{finding.title}</h3>
                {multipleFiles ? <span className="supplement-file">{fileNames.get(finding.fileId)}</span> : null}
              </header>
              <p className="supplement-message">{finding.message}</p>
              <dl className="supplement-fields">
                <div>
                  <dt>현재 확인</dt>
                  <dd><q>{finding.current}</q></dd>
                </div>
                <div>
                  <dt>원문 위치</dt>
                  <dd className="supplement-location">
                    <span>{finding.locations.join(", ")}</span>
                    {renderSource(finding.sources, { issue: finding.title, recommendation: finding.additions.join(", ") })}
                  </dd>
                </div>
                <div>
                  <dt>확인이 필요한 이유</dt>
                  <dd>{finding.reason}</dd>
                </div>
                <div>
                  <dt>추가하면 좋은 정보</dt>
                  <dd><ul>{finding.additions.map((addition) => <li key={addition}>{addition}</li>)}</ul></dd>
                </div>
                {finding.question ? (
                  <div>
                    <dt>예상 질문</dt>
                    <dd>{finding.question}</dd>
                  </div>
                ) : null}
              </dl>
              {finding.limitation ? <p className="supplement-limitation">{finding.limitation}</p> : null}
            </article>
          ))}
          {visible.length === 0 ? (
            <div className="filter-empty">
              <strong>이 중요도의 보완 항목이 없습니다.</strong>
              <button type="button" onClick={() => setFilter("all")}>전체 보기</button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
