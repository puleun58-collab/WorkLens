"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, Info } from "lucide-react";
import type { SourceRef } from "@/domain/document";
import {
  SUPPLEMENT_DOC_TYPE_LABELS,
  SUPPLEMENT_FILE_ROLE_LABELS,
  SUPPLEMENT_SEVERITY_LABELS,
  SUPPLEMENT_SHEET_STATUS_LABELS,
  type SupplementResult,
  type SupplementSeverity,
} from "@/domain/supplement";
import "./supplement.css";

const SEVERITIES: readonly SupplementSeverity[] = ["critical", "warning", "suggestion"];
const CHECK_TITLES: Record<SupplementResult["findings"][number]["check"], string> = {
  baseline: "비교 기준 미확인",
  cause: "원인 미확인",
  impact: "영향 설명 미확인",
  response: "대응 내용 미확인",
  owner: "담당자 미확인",
  schedule: "완료 시점 미확인",
  scope: "구체 대상·범위 미확인",
  budget: "비용 정보 미확인",
  conclusion: "결론 근거 미확인",
  target: "목표/예산 기준 미확인",
  period: "기준 기간 미확인",
  unit: "단위 미확인",
};

function findingTitle(finding: SupplementResult["findings"][number]): string {
  // Report-only information exists elsewhere; conflicting explanations are not
  // missing either. Preserve those and optional suggestion titles.
  if (finding.severity === "suggestion" || finding.scope !== "all") return finding.title;
  if (finding.check === "cause") {
    const verb = /주요\s*(증가|감소)\s*원인 설명/u.exec(finding.message)?.[1];
    if (verb) return `${verb} 원인 미확인`;
  }
  return CHECK_TITLES[finding.check];
}

function informativeReason(message: string, reason: string): string {
  const concise = reason.trim();
  const context = message.trim();
  if (!concise || (context && (context.includes(concise) || concise.includes(context)))) return "";
  if (/보고받는 사람이 .*원인을 물을 가능성|보고받는 사람은 후속 조치를 먼저 확인/u.test(concise)) return "";
  return concise;
}


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
          <Button type="button" variant={filter === "all" ? "secondary" : "ghost"} size="sm" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>전체 <b>{result.findings.length}</b></Button>
          {SEVERITIES.map((severity) => (
            <Button key={severity} type="button" variant={filter === severity ? "secondary" : "ghost"} size="sm" data-empty={counts[severity] === 0} aria-pressed={filter === severity} onClick={() => setFilter(severity)}>
              <i className={`severity-mark ${severity}`} aria-hidden="true" />{SUPPLEMENT_SEVERITY_LABELS[severity]} <b>{counts[severity]}</b>
            </Button>
          ))}
        </div>
        <dl className="supplement-meta">
          <div>
            <dt>자료 유형</dt>
            <dd>{multipleFiles
              ? (
                <ul className="supplement-coverage">
                  {result.files.map((file) => (
                    <li key={file.fileId}>
                      <span className="supplement-coverage-count">{fileNames.get(file.fileId) ?? file.fileName}</span>
                      <small>{[SUPPLEMENT_FILE_ROLE_LABELS[file.role], SUPPLEMENT_DOC_TYPE_LABELS[file.docType], file.period].filter(Boolean).join(" · ")}</small>
                    </li>
                  ))}
                  {result.files.every((file) => file.role !== "report") ? <li><small>핵심 보고자료를 확정하지 못했습니다. 다른 자료에만 있는 내용은 보고자료 보완으로 분류하지 않았습니다.</small></li> : null}
                </ul>
              )
              : SUPPLEMENT_DOC_TYPE_LABELS[result.files[0]?.docType ?? "general"]}</dd>
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
        {result.resolvedCount + result.confirmedCount > 0 ? (
          <p className="supplement-note">
            {result.resolvedCount > 0 ? `같은 자료의 다른 위치에서 설명을 확인한 후보 ${result.resolvedCount}건` : ""}
            {result.resolvedCount > 0 && result.confirmedCount > 0 ? ", " : ""}
            {result.confirmedCount > 0 ? `다른 자료에서 확인한 후보 ${result.confirmedCount}건` : ""}은 결과에서 제외했습니다.
          </p>
        ) : null}
        {result.semanticReview === "partial" ? (
          <p className="supplement-note">일부 항목은 의미 기반 재확인을 마치지 못했습니다. 다른 표현으로 설명된 내용이 있을 수 있습니다.</p>
        ) : null}
      </section>

      {result.questions.length > 0 ? (
        <section className="supplement-questions" aria-labelledby="supplement-questions-heading">
          <h3 id="supplement-questions-heading">보고 전 확인할 질문</h3>
          <ol className="supplement-readable-list" role="list">{result.questions.map((question, index) => <li key={question}><span className="supplement-list-marker" aria-hidden="true">{index + 1}.</span><span>{question}</span></li>)}</ol>
        </section>
      ) : null}

      {result.findings.length === 0 ? (
        <div className="status-panel info notice supplement-clear" role="status">
          <span className="status-panel-icon" aria-hidden="true"><Info size={18} fill="currentColor" stroke="white" strokeWidth={2.2} /></span>
          <strong>{result.semanticReview === "partial" ? "보완 검토 일부를 완료하지 못했습니다." : result.withheldCount > 0 ? "일부 항목은 보완 필요 여부를 판단하지 못했습니다." : "중요한 보완 항목을 확인하지 못했습니다."}</strong>
          <p>{result.semanticReview === "partial" ? "재확인하지 못한 항목이 있어 정상 0건으로 판단할 수 없습니다." : result.withheldCount > 0 ? "확인을 보류한 항목이 있어 보완 항목 0건으로 확정할 수 없습니다." : !complete
            ? "읽은 범위에서는 추가할 항목을 찾지 못했습니다. 읽지 못한 영역은 판단에서 제외했습니다."
            : partialByDesign
              ? "상세 분석한 시트에서는 추가할 항목을 찾지 못했습니다. 구조만 확인한 시트는 판단에서 제외했습니다."
              : "비교 기준, 원인, 영향, 대응, 담당, 일정, 결론 근거를 점검한 범위에서 추가할 항목을 찾지 못했습니다."}</p>
        </div>
      ) : (
        <>
          {(["all", "report"] as const).map((scope) => {
            const items = visible.filter((finding) => scope === "report" ? finding.scope === "report" : finding.scope !== "report");
            if (items.length === 0) return null;
            return (
              <section key={scope} className="supplement-list" aria-label={scope === "report" ? "보고자료 보완" : "전체 자료 보완"}>
                {multipleFiles ? (
                  <header className="supplement-scope">
                    <h3>{scope === "report" ? "보고자료 보완" : "전체 자료 보완"}</h3>
                    <p>{scope === "report" ? "다른 자료에는 있지만 핵심 보고자료에서는 확인하기 어려운 내용입니다." : "업로드한 자료 전체를 확인해도 찾지 못했거나 자료 간 설명이 다른 내용입니다."}</p>
                  </header>
                ) : null}
                {items.map((finding) => {
                  const reason = informativeReason(finding.message, finding.reason);
                  const hasOriginal = Boolean(finding.current || finding.locations.length || finding.evidence?.length || finding.evidenceLocations?.length || finding.linkNote);
                  return (
                    <article key={finding.id} className={`supplement-item check-issue severity-${finding.severity}`}>
                    <header className="supplement-item-head">
                      <span className="check-severity"><i className={`severity-mark ${finding.severity}`} aria-hidden="true" />{SUPPLEMENT_SEVERITY_LABELS[finding.severity]}</span>
                      <h3>{findingTitle(finding)}</h3>
                    </header>
                    <dl className="supplement-fields">
                      {finding.additions.length > 0 ? <div className="supplement-additions">
                        <dt>{finding.scope === "report" ? "확인된 내용" : finding.severity === "suggestion" ? "추가하면 좋은 정보" : "확인할 정보"}</dt>
                        <dd><ul className="supplement-readable-list" role="list">{finding.additions.map((addition) => <li key={addition}><span className="supplement-list-marker" aria-hidden="true">•</span><span>{addition}</span></li>)}</ul></dd>
                      </div> : null}
                      {finding.message || reason ? <div className="supplement-explanation">
                        <dt>{finding.scope === "conflict" ? "무엇이 다른가" : "확인 이유"}</dt>
                        <dd>
                          {finding.message ? <p className="supplement-message">{finding.message}</p> : null}
                          {reason ? <p>{reason}</p> : null}
                        </dd>
                      </div> : null}
                      {finding.question && !result.questions.includes(finding.question) ? (
                        <div>
                          <dt>예상 질문</dt>
                          <dd>{finding.question}</dd>
                        </div>
                      ) : null}
                      {finding.sources.length > 0 ? <div className="supplement-source">
                        <dt>근거</dt>
                        <dd>{renderSource(finding.sources, { issue: finding.title, recommendation: finding.additions.join(", ") })}</dd>
                      </div> : null}
                    </dl>
                    {hasOriginal ? <details className="supplement-original">
                      <summary>현재 자료 및 원문 위치 보기<ChevronDown aria-hidden="true" /></summary>
                      <dl className="supplement-fields">
                        {finding.current ? <div>
                          <dt>현재 자료</dt>
                          <dd><q>{finding.current}</q></dd>
                        </div> : null}
                        {finding.locations.length > 0 ? <div>
                          <dt>{finding.scope === "report" ? "보완 대상" : "원문 위치"}</dt>
                          <dd className="supplement-location"><span>{finding.locations.join(", ")}</span></dd>
                        </div> : null}
                        {finding.evidence?.length || finding.evidenceLocations?.length ? (
                          <div>
                            <dt>{finding.scope === "conflict" ? "자료별 설명" : "관련 근거"}</dt>
                            <dd className="supplement-location">
                              {finding.evidenceLocations?.length ? <span>{finding.evidenceLocations.join(", ")}</span> : null}
                              {finding.evidence?.length ? renderSource(finding.evidence, { issue: finding.title, recommendation: "" }) : null}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                      {finding.linkNote ? <p className="supplement-note">{finding.linkNote}</p> : null}
                    </details> : null}
                    {finding.limitation ? <p className="supplement-limitation">{finding.limitation}</p> : null}
                    </article>
                  );
                })}
              </section>
            );
          })}
          {visible.length === 0 ? (
            <div className="filter-empty">
              <strong>이 중요도의 보완 항목이 없습니다.</strong>
              <Button variant="outline" type="button" onClick={() => setFilter("all")}>전체 보기</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
