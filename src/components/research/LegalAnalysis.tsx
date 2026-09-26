"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  LAW_ANALYSIS_CASE_MAX_CHARS, LAW_ANALYSIS_ERROR, LAW_ANALYSIS_LAW_NAME_MAX_CHARS, LAW_ANALYSIS_MODES, LAW_ANALYSIS_TEXT_MAX_CHARS,
  lawAnalysisOutcome, lawAnalysisRequestFor,
  type LawAnalysisData, type LawAnalysisMode, type LawAnalysisOutcome, type LawAnalysisRequest,
} from "@/lib/law-analysis";
import {
  citationOverallLabel, citeCheckResult, impactMapResult, splitAnalysisText, verifyCitationsResult,
  type AnalysisSection,
} from "@/lib/law-analysis-parse";
import { LawTextBlock } from "./LawTextBlock";
import "./legal-analysis.css";
import { SourceToggleSummary } from "./SourceToggleSummary";

/** A request opened from a law article or a decision detail; `origin` drives the return action. */
export type LinkedAnalysis =
  | { mode: "cite_check"; caseNumber: string; origin: "decisions" }
  | { mode: "applicable_law"; lawName: string; jo: string; origin: "law" }
  | { mode: "impact_map"; lawName: string; jo: string; origin: "law" };

interface LegalAnalysisProps {
  linkedRequest: LinkedAnalysis | null;
  onReturn: (origin: LinkedAnalysis["origin"]) => void;
}

interface ModeResult {
  request: LawAnalysisRequest;
  outcome: LawAnalysisOutcome | null;
  loading: boolean;
}

const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";

export function LegalAnalysis({ linkedRequest, onReturn }: LegalAnalysisProps) {
  const [mode, setMode] = useState<LawAnalysisMode>("verify_citations");
  const [text, setText] = useState("");
  const [caseNumber, setCaseNumber] = useState("");
  const [applicable, setApplicable] = useState({ lawName: "", date: "", jo: "" });
  const [impact, setImpact] = useState({ lawName: "", jo: "" });
  const [results, setResults] = useState<Partial<Record<LawAnalysisMode, ModeResult>>>({});
  const [linkedOrigin, setLinkedOrigin] = useState<LinkedAnalysis["origin"] | null>(null);
  const requests = useRef(new Map<LawAnalysisMode, AbortController>());

  useEffect(() => {
    const pending = requests.current;
    return () => pending.forEach((controller) => controller.abort());
  }, []);

  const run = useCallback(async (request: LawAnalysisRequest) => {
    requests.current.get(request.mode)?.abort();
    const controller = new AbortController();
    requests.current.set(request.mode, controller);
    setResults((current) => ({ ...current, [request.mode]: { request, outcome: null, loading: true } }));
    let outcome: LawAnalysisOutcome;
    try {
      const response = await fetch("/api/law/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      outcome = lawAnalysisOutcome(response.ok, body);
    } catch {
      outcome = { kind: "error", message: LAW_ANALYSIS_ERROR };
    }
    if (controller.signal.aborted) return;
    requests.current.delete(request.mode);
    setResults((current) => ({ ...current, [request.mode]: { request, outcome, loading: false } }));
  }, []);

  useEffect(() => {
    if (!linkedRequest) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setMode(linkedRequest.mode);
      setLinkedOrigin(linkedRequest.origin);
      if (linkedRequest.mode === "cite_check") {
        setCaseNumber(linkedRequest.caseNumber);
        void run({ mode: "cite_check", caseNumber: linkedRequest.caseNumber });
        requestAnimationFrame(() => document.getElementById("analysis-case")?.focus());
      } else if (linkedRequest.mode === "applicable_law") {
        // The reference date is the user's act/contract date; it is never defaulted to today.
        setApplicable((current) => ({ ...current, lawName: linkedRequest.lawName, jo: linkedRequest.jo }));
        requestAnimationFrame(() => document.getElementById("analysis-applicable-date")?.focus());
      } else {
        setImpact({ lawName: linkedRequest.lawName, jo: linkedRequest.jo });
        void run({ mode: "impact_map", lawName: linkedRequest.lawName, jo: linkedRequest.jo });
        requestAnimationFrame(() => document.getElementById("analysis-impact-jo")?.focus());
      }
    });
    return () => { active = false; };
  }, [linkedRequest, run]);

  const current = results[mode];
  const loading = current?.loading === true;
  const request = lawAnalysisRequestFor(mode, { text, caseNumber, applicable, impact });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (request && !loading) void run(request);
  }

  const submitLabel = { verify_citations: "인용 검증", cite_check: "확인", applicable_law: "적용 법령 확인", impact_map: "영향도 확인" }[mode];

  return <div className="legal-analysis">
    {linkedOrigin && <button type="button" className="law-search-link" onClick={() => onReturn(linkedOrigin)}>
      {linkedOrigin === "law" ? "← 법령으로" : "← 판례 상세로"}
    </button>}
    <div className="law-view-switch legal-analysis-modes" role="group" aria-label="검증·분석 유형">
      {LAW_ANALYSIS_MODES.map((item) => <button key={item.value} type="button" aria-pressed={mode === item.value} onClick={() => setMode(item.value)}>
        {item.label}
      </button>)}
    </div>

    <form className="legal-analysis-form" onSubmit={submit} aria-label={`${LAW_ANALYSIS_MODES.find((item) => item.value === mode)?.label} 입력`}>
      {mode === "verify_citations" && <>
        <label htmlFor="analysis-text">검증할 문장을 입력하세요.</label>
        <textarea id="analysis-text" value={text} rows={6} maxLength={LAW_ANALYSIS_TEXT_MAX_CHARS} placeholder="예: 민법 제750조에 따라 손해배상을 청구할 수 있다." onChange={(event) => setText(event.target.value)} aria-describedby="analysis-text-help" />
        <p id="analysis-text-help" className="legal-analysis-help">
          <span>법령 조문·판례 인용이 법제처 자료에 실존하는지 확인합니다.</span>
          <span className="legal-analysis-count">{text.length.toLocaleString("ko-KR")} / {LAW_ANALYSIS_TEXT_MAX_CHARS.toLocaleString("ko-KR")}자</span>
        </p>
      </>}
      {mode === "cite_check" && <>
        <label htmlFor="analysis-case">사건번호</label>
        <input id="analysis-case" type="text" value={caseNumber} maxLength={LAW_ANALYSIS_CASE_MAX_CHARS} placeholder="예: 2013다61381" autoComplete="off" onChange={(event) => setCaseNumber(event.target.value)} />
        <p className="legal-analysis-help"><span>후속 판례의 인용을 역추적해 변경·폐기 신호를 확인합니다.</span></p>
      </>}
      {mode === "applicable_law" && <div className="legal-analysis-fields">
        <label htmlFor="analysis-applicable-law">법령명
          <input id="analysis-applicable-law" type="text" value={applicable.lawName} maxLength={LAW_ANALYSIS_LAW_NAME_MAX_CHARS} placeholder="예: 도로교통법" onChange={(event) => setApplicable({ ...applicable, lawName: event.target.value })} />
        </label>
        <label htmlFor="analysis-applicable-date">기준일
          <input id="analysis-applicable-date" type="date" value={applicable.date} min="1900-01-01" max="2100-12-31" onChange={(event) => setApplicable({ ...applicable, date: event.target.value })} />
        </label>
        <label htmlFor="analysis-applicable-jo">조문 (선택)
          <input id="analysis-applicable-jo" type="text" value={applicable.jo} placeholder="예: 제44조" onChange={(event) => setApplicable({ ...applicable, jo: event.target.value })} />
        </label>
        <p className="legal-analysis-help"><span>기준일은 행위·계약·처분 등 판단하려는 시점입니다.</span></p>
      </div>}
      {mode === "impact_map" && <div className="legal-analysis-fields legal-analysis-fields-2">
        <label htmlFor="analysis-impact-law">법령명
          <input id="analysis-impact-law" type="text" value={impact.lawName} maxLength={LAW_ANALYSIS_LAW_NAME_MAX_CHARS} placeholder="예: 민법" onChange={(event) => setImpact({ ...impact, lawName: event.target.value })} />
        </label>
        <label htmlFor="analysis-impact-jo">조문
          <input id="analysis-impact-jo" type="text" value={impact.jo} placeholder="예: 제103조" onChange={(event) => setImpact({ ...impact, jo: event.target.value })} />
        </label>
      </div>}
      <div className="legal-analysis-actions">
        <button type="submit" className="law-search-button" disabled={!request || loading}>{loading ? "확인 중…" : submitLabel}</button>
      </div>
    </form>

    {current && <section className="legal-analysis-result" aria-labelledby="analysis-result-heading" aria-busy={loading}>
      <h2 id="analysis-result-heading">{mode === "verify_citations" || mode === "cite_check" ? "검증 결과" : "분석 결과"}</h2>
      {current.loading ? <p className="law-search-note" role="status">법제처 자료를 조회하는 중… 조회 범위에 따라 시간이 걸릴 수 있습니다.</p>
        : current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <button type="button" className="law-search-link" onClick={() => void run(current.request)}>다시 시도</button>
        </div>
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status" data-marker={current.outcome.data.marker}>
          <p className="law-search-note">{current.outcome.data.marker === "INVALID_ARGUMENT" ? "입력한 조문 번호를 해석하지 못했습니다." : "요청한 법령·조문·판례를 법제처 자료에서 찾지 못했습니다."}</p>
          <LawTextBlock className="legal-analysis-raw" text={current.outcome.data.text} />
        </div>
        : current.outcome?.kind === "found" ? <AnalysisResult data={current.outcome.data} />
        : null}
    </section>}
  </div>;
}

function Lines({ lines }: { lines: string[] }) {
  return lines.length ? <LawTextBlock className="legal-analysis-lines" text={lines.join("\n")} /> : null;
}

function Sections({ sections }: { sections: AnalysisSection[] }) {
  return <>{sections.map((section, index) => <div key={index} className="legal-analysis-section">
    {section.heading && <h3>{section.heading}</h3>}
    <Lines lines={section.lines} />
  </div>)}</>;
}

function AnalysisResult({ data }: { data: LawAnalysisData }) {
  let body: ReactNode;
  let note: string | undefined;
  if (data.mode === "verify_citations") {
    const result = verifyCitationsResult(data.text);
    const overall = data.markers.includes("NO_CITATIONS_FOUND")
      ? "검증할 인용을 찾지 못했습니다. 검증에 성공했다는 뜻이 아닙니다."
      : citationOverallLabel(result.overallMarker);
    body = <>
      {overall && <p className="legal-analysis-overall" data-marker={result.overallMarker ?? "NO_CITATIONS_FOUND"}>{overall}</p>}
      <Lines lines={result.summary} />
      {(["law", "case"] as const).map((group) => {
        const items = result.items.filter((item) => item.group === group);
        return items.length ? <div key={group} className="legal-analysis-section">
          <h3>{group === "law" ? "법령 인용" : "판례 인용"}</h3>
          <ul className="legal-analysis-citations">
            {items.map((item, index) => <li key={index} className={`is-${item.tone}`} data-markers={item.markers.join(" ")}>
              <span className="legal-analysis-status">{item.label}</span>
              <span className="legal-analysis-citation-text">{item.text}</span>
            </li>)}
          </ul>
        </div> : null;
      })}
      <Sections sections={result.notes} />
    </>;
  } else if (data.mode === "cite_check") {
    const result = citeCheckResult(data.text);
    note = "법제처에 수록된 판례를 기준으로 확인한 결과입니다.";
    body = <>
      {result.title && <h3 className="legal-analysis-title">{result.title}</h3>}
      <Lines lines={result.target} />
      {result.verdict && <div className={`legal-analysis-verdict is-${result.verdict.tone}`}>
        <span className="legal-analysis-status">판정</span>
        <LawTextBlock className="legal-analysis-lines" text={result.verdict.text} />
      </div>}
      <Sections sections={result.sections} />
      {result.limitation.length > 0 && <Lines lines={result.limitation} />}
    </>;
  } else if (data.mode === "impact_map") {
    const result = impactMapResult(data.text);
    body = <>
      {result.title && <h3 className="legal-analysis-title">{result.title}</h3>}
      {result.sections.map((section, index) => index === result.graphIndex && result.axes.length
        ? <div key={index} className="legal-analysis-section">
          <h3>{section.heading}</h3>
          <ul className="legal-analysis-axes">
            {result.axes.map((axis) => <li key={axis.label} className={axis.failed ? "is-failed" : undefined}>
              <span className="legal-analysis-axis-label">{axis.label}</span>
              <span className="legal-analysis-axis-value">{axis.failed ? `조회 실패 · 건수 미확인 — ${axis.value}` : axis.value}</span>
              {axis.items.length > 0 && <ul>{axis.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>}
            </li>)}
          </ul>
          <Lines lines={result.graphNotes} />
        </div>
        : <Sections key={index} sections={[section]} />)}
    </>;
  } else {
    const parsed = splitAnalysisText(data.text);
    body = <>
      {parsed.title && <h3 className="legal-analysis-title">{parsed.title}</h3>}
      <Sections sections={parsed.sections} />
    </>;
  }
  return <div className="legal-analysis-output" data-mode={data.mode} data-markers={data.markers.join(" ")}>
    {body}
    <details className="law-detail-source">
      <SourceToggleSummary />
      <LawTextBlock className="legal-analysis-raw" text={data.text} />
    </details>
    <p className="legal-analysis-note">{note ? `${note} ` : ""}{RESULT_NOTE}</p>
  </div>;
}
