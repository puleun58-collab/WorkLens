"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import {
  LAW_ANALYSIS_CASE_MAX_CHARS, LAW_ANALYSIS_ERROR, LAW_ANALYSIS_LAW_NAME_MAX_CHARS, LAW_ANALYSIS_MODES, LAW_ANALYSIS_TEXT_MAX_CHARS,
  lawAnalysisOutcome, lawAnalysisRequestFor,
  type LawAnalysisData, type LawAnalysisMode, type LawAnalysisOutcome, type LawAnalysisRequest,
} from "@/lib/law-analysis";
import {
  applicableLawPresentation, citeCheckResult, impactMapPresentation, verifyCitationsResult,
  type AnalysisSection,
} from "@/lib/law-analysis-parse";
import { lawDisplayText } from "@/lib/law-display";
import { lawTextOutcome, type LawTextOutcome } from "@/lib/law-search";
import { LawTextBlock } from "./LawTextBlock";
import "./legal-analysis.css";
import { CitationResult } from "./CitationEvidence";
import { SourceToggleSummary } from "./SourceToggleSummary";

/** A request opened from a law article or a decision detail; `origin` drives the return action. */
export type LinkedAnalysis =
  | { mode: "cite_check"; caseNumber: string; origin: "decisions" }
  | { mode: "applicable_law"; lawName: string; jo: string; origin: "law" }
  | { mode: "impact_map"; lawName: string; jo: string; origin: "law" };

/** A decision search the impact map suggests, opened in 판례·결정례. */
export interface RelatedSearch {
  query: string;
  domain: "precedent" | "interpretation";
}

interface LegalAnalysisProps {
  linkedRequest: LinkedAnalysis | null;
  onReturn: (origin: LinkedAnalysis["origin"]) => void;
  onRelatedSearch?: (search: RelatedSearch) => void;
}

interface ModeResult {
  request: LawAnalysisRequest;
  outcome: LawAnalysisOutcome | null;
  loading: boolean;
  /** When the result arrived; the law version a citation was checked against is the one in force then. */
  completedAt?: number;
}

const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";
const NO_CITATIONS = "검증할 법령·판례 인용을 찾지 못했습니다.";
const NO_CITATIONS_HELP = "법령명, 조문 또는 사건번호가 포함된 문장으로 다시 입력해 주세요. 예: 민법 제750조, 2013다61381";

export function LegalAnalysis({ linkedRequest, onReturn, onRelatedSearch }: LegalAnalysisProps) {
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
    setResults((current) => ({ ...current, [request.mode]: { request, outcome, loading: false, completedAt: Date.now() } }));
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

  const ACTION_HELP: Partial<Record<typeof mode, string>> = {
    cite_check: "후속 판례의 인용을 역추적해 변경·폐기 정황을 확인합니다.",
    applicable_law: "기준일은 행위·계약·처분 등 판단하려는 시점입니다.",
  };

  return <Tabs className="legal-analysis" value={mode} onValueChange={(value) => setMode(value as LawAnalysisMode)}>
    {linkedOrigin && <Button variant="link" type="button" className="h-auto max-w-full whitespace-normal px-0 text-left" onClick={() => onReturn(linkedOrigin)}>
      {linkedOrigin === "law" ? "← 법령으로" : "← 판례 상세로"}
    </Button>}
    <TabsList className="flex-wrap" aria-label="검증·분석 유형" variant="underline">
      {LAW_ANALYSIS_MODES.map((item) => <TabsTab key={item.value} value={item.value}>{item.label}</TabsTab>)}
    </TabsList>

    <TabsPanel value={mode} className="grid gap-5">
    <form className="legal-analysis-form" onSubmit={submit} aria-label={`${LAW_ANALYSIS_MODES.find((item) => item.value === mode)?.label} 입력`}>
      {mode === "verify_citations" && <>
        <Label htmlFor="analysis-text">검증할 문장을 입력하세요.</Label>
        <Textarea id="analysis-text" value={text} rows={6} maxLength={LAW_ANALYSIS_TEXT_MAX_CHARS} placeholder="예: 민법 제750조에 따라 손해배상을 청구할 수 있다." onChange={(event) => setText(event.target.value)} aria-describedby="analysis-text-help" />
        <p id="analysis-text-help" className="legal-analysis-help">
          <span>법령 조문·판례 인용을 법제처 자료에서 확인합니다.</span>
          <span className="legal-analysis-count">{text.length.toLocaleString("ko-KR")} / {LAW_ANALYSIS_TEXT_MAX_CHARS.toLocaleString("ko-KR")}자</span>
        </p>
      </>}
      {mode === "cite_check" && <>
        <Label htmlFor="analysis-case">사건번호</Label>
        <Input id="analysis-case" type="text" value={caseNumber} maxLength={LAW_ANALYSIS_CASE_MAX_CHARS} placeholder="예: 2013다61381" autoComplete="off" onChange={(event) => setCaseNumber(event.target.value)} />

      </>}
      {mode === "applicable_law" && <div className="legal-analysis-fields">
        <Label htmlFor="analysis-applicable-law">법령명
          <Input id="analysis-applicable-law" type="text" value={applicable.lawName} maxLength={LAW_ANALYSIS_LAW_NAME_MAX_CHARS} placeholder="예: 도로교통법" onChange={(event) => setApplicable({ ...applicable, lawName: event.target.value })} />
        </Label>
        <Label htmlFor="analysis-applicable-date">기준일
          <Input id="analysis-applicable-date" nativeInput type="date" value={applicable.date} min="1900-01-01" max="2100-12-31" onChange={(event) => setApplicable({ ...applicable, date: event.target.value })} />
        </Label>
        <Label htmlFor="analysis-applicable-jo">조문 (선택)
          <Input id="analysis-applicable-jo" type="text" value={applicable.jo} placeholder="예: 제44조" onChange={(event) => setApplicable({ ...applicable, jo: event.target.value })} />
        </Label>

      </div>}
      {mode === "impact_map" && <div className="legal-analysis-fields legal-analysis-fields-2">
        <Label htmlFor="analysis-impact-law">법령명
          <Input id="analysis-impact-law" type="text" value={impact.lawName} maxLength={LAW_ANALYSIS_LAW_NAME_MAX_CHARS} placeholder="예: 민법" onChange={(event) => setImpact({ ...impact, lawName: event.target.value })} />
        </Label>
        <Label htmlFor="analysis-impact-jo">조문
          <Input id="analysis-impact-jo" type="text" value={impact.jo} placeholder="예: 제103조" onChange={(event) => setImpact({ ...impact, jo: event.target.value })} />
        </Label>
      </div>}
      <div className="legal-analysis-actions legal-analysis-action-row">
        {ACTION_HELP[mode] && <p className="legal-analysis-help"><span>{ACTION_HELP[mode]}</span></p>}
        <Button type="submit" className="law-search-button" disabled={!request || loading}>{loading ? "확인 중…" : "실행"}</Button>
      </div>
    </form>

    {current && <section className="legal-analysis-result" aria-labelledby="analysis-result-heading" aria-busy={loading}>
      <h2 id="analysis-result-heading">{mode === "verify_citations" || mode === "cite_check" ? "검증 결과" : "분석 결과"}</h2>
      {current.loading ? <p className="law-search-note" role="status">법제처 자료를 조회하는 중… 조회 범위에 따라 시간이 걸릴 수 있습니다.</p>
        : current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <Button variant="link" type="button" className="h-auto max-w-full whitespace-normal px-0 text-left" onClick={() => void run(current.request)}>다시 시도</Button>
        </div>
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status" data-marker={current.outcome.data.marker}>
          <p className="law-search-note">요청한 법령·조문·판례를 법제처 자료에서 찾지 못했습니다. 조회 실패와는 다른 결과입니다.</p>
        </div>
        : current.outcome?.kind === "found" && current.completedAt ? <AnalysisResult key={current.completedAt} data={current.outcome.data} request={current.request} completedAt={current.completedAt} onRelatedSearch={onRelatedSearch} />
        : null}
    </section>}
    </TabsPanel>
  </Tabs>;
}

function analysisTitle(title: string): string {
  return lawDisplayText(title
    .replace(/^행위시법 판단: (.+) @ (\d{4}\.\d{2}\.\d{2})$/u, "행위시법 판단: $1 · 기준일 $2")
    .replace(/^Impact Map: /u, "조문 영향도: ")
    .replace(/^판례 인용 추적 \(Citator\): /u, "판례 인용 추적: "));
}

/** Limit machine-label cleanup to generated analysis prose; never rewrite quoted legal text or source. */
function analysisStatus(text: string): string {
  return text
    .replace(/\[[A-Z][A-Z_]{2,}\]\s*/gu, "")
    .replace(/API 일시 실패/gu, "자료 조회 일시 실패")
    .replace(/\(\s*MST \d{6},\s*/gu, "(")
    .replace(/\s*\(MST \d{6}\)/gu, "");
}

function Lines({ lines }: { lines: string[] }) {
  return lines.length ? <LawTextBlock className="legal-analysis-lines" text={lines.map(analysisStatus).join("\n")} /> : null;
}

function Sections({ sections }: { sections: AnalysisSection[] }) {
  return <>{sections.map((section, index) => <div key={index} className="legal-analysis-section">
    {section.heading && <h3>{lawDisplayText(analysisStatus(section.heading))}</h3>}
    <Lines lines={section.lines} />
  </div>)}</>;
}

function AxisLabel({ label }: { label: string }) {
  const match = /(.+?)(\([^()]*\)|（[^（）]*）)$/u.exec(label);
  return <span className="legal-analysis-axis-label">
    {match ? <>{lawDisplayText(match[1])}<wbr /><span className="legal-analysis-axis-suffix">{lawDisplayText(match[2])}</span></> : lawDisplayText(label)}
  </span>;
}

function AnalysisResult({ data, request, completedAt, onRelatedSearch }: { data: LawAnalysisData; request: LawAnalysisRequest; completedAt: number; onRelatedSearch?: (search: RelatedSearch) => void }) {
  let body: ReactNode;
  let source: ReactNode;
  if (data.mode === "verify_citations") {
    const result = verifyCitationsResult(data.text);
    body = result.empty ? <>
      <p className="legal-analysis-overall" data-marker="NO_CITATIONS_FOUND">{NO_CITATIONS}</p>
      <p className="law-search-note">{NO_CITATIONS_HELP}</p>
    </> : <CitationResult
      items={result.items}
      groups={result.groups}
      overallMarker={result.overallMarker}
      notes={<Sections sections={result.notes} />}
      input={request.mode === "verify_citations" ? request.text : ""}
      verifiedAt={completedAt}
    />;
  } else if (data.mode === "cite_check") {
    const result = citeCheckResult(data.text);
    const detailStart = result.target.findIndex((line) => /^\s*(?:판시사항|판결요지|참조조문|참조판례)\s*:/u.test(line));
    const targetSummary = detailStart < 0 ? result.target : result.target.slice(0, detailStart);
    const targetDetails = detailStart < 0 ? [] : result.target.slice(detailStart);
    body = <>
      {result.title && <h3 className="legal-analysis-title">{analysisTitle(result.title)}</h3>}
      <Lines lines={targetSummary} />
      {result.verdict && <div className={`legal-analysis-verdict is-${result.verdict.tone}`}>
        <span className="legal-analysis-status">판정</span>
        <Lines lines={result.verdict.lines} />
      </div>}
      {result.limitation.length > 0 && <Lines lines={result.limitation.map((line) => `⚠️ 한계: ${line}`)} />}
    </>;
    source = <details className="law-detail-source">
      <SourceToggleSummary label="근거 보기" openLabel="근거 접기" />
      <p className="law-search-note">대상 판례 정보와 후속 인용·본문 확인 결과입니다. 판결문 원문은 이 결과에 포함되지 않습니다.</p>
      <Lines lines={targetDetails} />
      {result.sections.length > 0 ? <Sections sections={result.sections} />
        : <p className="law-search-note">제공된 후속 판례 목록이 없습니다.</p>}
    </details>;
  } else if (data.mode === "impact_map") {
    const view = impactMapPresentation(data.text);
    const sourceSections = view.sources.filter((section) => !/\[(?:NOT_FOUND|FAILED|ERROR|UPSTREAM_NO_DATA)\]/u.test(section.heading ?? "") && section.lines.length > 0);
    const sourceFailures = view.sources.filter((section) => !sourceSections.includes(section));
    const references = view.axes.filter((axis) => axis.items.length > 0);
    const related = view.related.filter((item) => item.domain);
    body = <>
      {view.title && <h3 className="legal-analysis-title">{analysisTitle(view.title)}</h3>}
      {view.law && <p className="legal-analysis-lines">법령: {lawDisplayText(view.law)}</p>}
      <Sections sections={[...sourceFailures, ...view.other]} />
      {view.axes.length > 0 && <div className="legal-analysis-section">
        <h3>인용 현황</h3>
        <p className="law-search-note">이 조문을 인용한 판례·헌재 결정례·법령해석례·행정심판례와 이 법령을 언급한 자치법규를 확인합니다.</p>
        <ul className="legal-analysis-axes">
          {view.axes.map((axis) => <li key={axis.label} className={axis.state === "failed" ? "is-failed" : undefined} data-state={axis.state}>
            <AxisLabel label={axis.label} />
            <span className="legal-analysis-axis-value">
              <strong>{axis.headline}</strong>
              {axis.detail && <span className="legal-analysis-axis-detail">{axis.detail}</span>}
            </span>
          </li>)}
        </ul>
        <p className="law-search-note">법제처 검색 결과에는 유사 조문이나 다른 법령이 함께 포함될 수 있어, 실제 법령명과 조문이 일치하는 결과만 집계합니다.</p>
        <Lines lines={view.notes} />
      </div>}
      {view.total && <div className="legal-analysis-section">
        <h3>{view.total.headline}</h3>
        <Lines lines={view.total.lines} />
      </div>}
      {view.citedLaws.length > 0 && <Sections sections={[{ heading: `이 조문이 인용한 다른 법령 ${view.citedLaws.length}건`, lines: view.citedLaws }]} />}
      {related.length > 0 && onRelatedSearch && <div className="legal-analysis-section">
        <h3>관련 조회</h3>
        <div className="law-related-actions">
          {related.map((item) => <Button variant="link" key={item.query + item.label} type="button" className="h-auto max-w-full whitespace-normal px-0 text-left" onClick={() => onRelatedSearch({ query: item.query, domain: item.domain! })}>
            {item.label}
          </Button>)}
        </div>
      </div>}
    </>;
    source = <details className="law-detail-source">
      <SourceToggleSummary label="근거·원문 보기" openLabel="근거·원문 접기" />
      {sourceSections.length > 0
        ? <LawTextBlock className="legal-analysis-raw" text={sourceSections.map((section) => `${section.heading}\n${section.lines.join("\n")}`).join("\n\n")} />
        : <p className="law-search-note">조회된 조문 원문이 이 결과에 포함되지 않습니다.</p>}
      {references.length > 0 && <Sections sections={references.map((axis) => ({ heading: `${axis.label} · 조회된 항목`, lines: axis.items }))} />}
    </details>;
  } else {
    const parsed = applicableLawPresentation(data.text);
    body = <>
      {parsed.title && <h3 className="legal-analysis-title">{analysisTitle(parsed.title)}</h3>}
      <Sections sections={parsed.sections} />
    </>;
    source = <ApplicableLawSource parsed={parsed} jo={request.mode === "applicable_law" ? request.jo : undefined} />;
  }
  return <div className="legal-analysis-output" data-mode={data.mode} data-markers={data.markers.join(" ")}>
    {body}
    {source}
    <p className="legal-analysis-note">{RESULT_NOTE}</p>
  </div>;
}

function ApplicableLawSource({ parsed, jo }: { parsed: ReturnType<typeof applicableLawPresentation>; jo?: string }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<LawTextOutcome | null>(null);
  const article = jo ?? parsed.jo;
  const mst = parsed.mst;

  useEffect(() => {
    if (!open || !mst) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/law/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mst, ...(article ? { jo: article } : {}) }),
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!controller.signal.aborted) setSource(lawTextOutcome(response.ok, body));
      } catch {
        if (!controller.signal.aborted) setSource({ kind: "error", message: "원문을 불러오지 못했습니다." });
      }
    })();
    return () => controller.abort();
  }, [open, mst, article]);

  const hasSource = source?.kind === "found" && Boolean(source.data.text.trim());
  const excerpts = hasSource && source.data.mode === "article"
    ? parsed.excerpts.filter((section) => section.heading !== "조문 원문")
    : parsed.excerpts;
  const evidence = [
    ...(hasSource ? [`${source.data.mode === "toc" ? "법령 목차" : article ? "조문 원문" : "법령 원문"}\n${source.data.text}`] : []),
    ...excerpts.map((section) => `${section.heading}\n${section.lines.join("\n")}`),
  ].join("\n\n");
  return <details className="law-detail-source" onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setSource(null);
  }}>
    <SourceToggleSummary />
    {open && <>
      {mst && !source && <p className="law-search-note" role="status">법령 원문을 불러오는 중…</p>}
      {evidence && <LawTextBlock className="legal-analysis-raw" text={evidence} />}
      {(source?.kind === "error" || (source?.kind === "found" && !hasSource)) && <p className="law-search-note" role="status">원문을 불러오지 못했습니다.</p>}
      {source?.kind === "missing" && <p className="law-search-note" role="status">요청한 {article ? "조문" : "법령"} 원문을 찾지 못했습니다.</p>}
      {!mst && !evidence && <p className="law-search-note" role="status">원문을 불러오지 못했습니다.</p>}
    </>}
  </details>;
}
