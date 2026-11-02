"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleMinus, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  type AnalysisSection, type ApplicableLawPresentation, type ApplicableLawVersion, type ImpactAxisState, type ImpactMapPresentation,
} from "@/lib/law-analysis-parse";
import { lawDisplayText } from "@/lib/law-display";
import { lawTextOutcome, type LawTextOutcome } from "@/lib/law-search";
import { LawTextBlock } from "./LawTextBlock";
import "./legal-analysis.css";
import { AnalysisResultCard, CitationResult } from "./CitationEvidence";
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
    cite_check: "후속 판례의 인용을 역추적해 변경·폐기 정황 확인",
    applicable_law: "기준일: 행위·계약·처분 등 판단하려는 시점",
  };

  return <Tabs className="legal-analysis" value={mode} onValueChange={(value) => setMode(value as LawAnalysisMode)}>
    {linkedOrigin && <Button variant="link" type="button" className="law-back-link h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => onReturn(linkedOrigin)}>
      {linkedOrigin === "law" ? "← 법령으로" : "← 판례 상세로"}
    </Button>}
    <TabsList className="law-subnav-tabs flex-wrap" aria-label="검증·분석 유형" variant="underline">
      {LAW_ANALYSIS_MODES.map((item) => <TabsTab key={item.value} value={item.value}>{item.label}</TabsTab>)}
    </TabsList>

    <TabsPanel value={mode} className="grid gap-5">
    <form className="legal-analysis-form" onSubmit={submit} aria-label={`${LAW_ANALYSIS_MODES.find((item) => item.value === mode)?.label} 입력`}>
      {mode === "verify_citations" && <>
        <Label htmlFor="analysis-text">검증할 문장을 입력하세요.</Label>
        <Textarea id="analysis-text" value={text} rows={6} maxLength={LAW_ANALYSIS_TEXT_MAX_CHARS} placeholder="예: 민법 제750조에 따라 손해배상을 청구할 수 있다." onChange={(event) => setText(event.target.value)} aria-describedby="analysis-text-help" />
        <p id="analysis-text-help" className="legal-analysis-help">
          <span>법령 조문·판례 인용을 법제처 자료에서 확인</span>
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
      <span className="sr-only" role="status">{loading ? "확인 중…" : ""}</span>
    </form>

    {current && !current.loading && <section className="legal-analysis-result" aria-label={current.request.mode === "verify_citations" || current.request.mode === "cite_check" ? "검증 결과" : "분석 결과"}>
      {current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <Button variant="link" type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => void run(current.request)}>다시 시도</Button>
        </div>
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status" data-marker={current.outcome.data.marker}>
          <p className="law-search-note">요청한 법령·조문·판례를 법제처 자료에서 찾지 못했습니다. 조회 실패와는 다른 결과입니다</p>
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
    .replace(/\(\s*MST \d+,\s*/gu, "(")
    .replace(/\s*\(MST \d+\)/gu, "");
}

function Lines({ lines }: { lines: string[] }) {
  return lines.length ? <LawTextBlock className="legal-analysis-lines" text={lines.map(analysisStatus).join("\n")} /> : null;
}

const SECTION_ITEM_MARKER = /^(?:[-•]|\d{1,3}[.)])\s/u;

function sectionLineIndent(line: string): number {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

interface SectionLineItem {
  lines: string[];
  /** A hairline precedes this entry; paragraph breaks inside one source text (blank-line splits) stay undivided. */
  divided: boolean;
}

/**
 * Group a section's lines into evidence entries. A line opens a new entry
 * when it dedents below the previous line or repeats the entry marker at the
 * same depth; deeper lines (맥락 등) stay with their entry. Blank lines only
 * separate paragraphs of one entry, so they split without a divider.
 */
function sectionLineItems(lines: string[]): SectionLineItem[] {
  const items: SectionLineItem[] = [];
  let current: string[] = [];
  let divided = true;
  const flush = () => { if (current.length) items.push({ lines: current, divided }); current = []; };
  for (const line of lines) {
    if (!line.trim()) { flush(); divided = false; continue; }
    const previous = current[current.length - 1];
    if (previous !== undefined) {
      const indent = sectionLineIndent(line);
      if (indent < sectionLineIndent(previous) || (indent === sectionLineIndent(previous) && SECTION_ITEM_MARKER.test(line.slice(indent)))) { flush(); divided = true; }
    }
    current.push(line);
  }
  flush();
  return items;
}

/** Section body as entry blocks: entries share the section's left baseline (common indent dropped, relative depth kept). */
function SectionLines({ lines }: { lines: string[] }) {
  const items = sectionLineItems(lines.map(analysisStatus));
  if (!items.length) return null;
  return <div className="legal-analysis-lines legal-analysis-items">
    {items.map((item, itemIndex) => {
      const base = Math.min(...item.lines.map(sectionLineIndent));
      const shown = lawDisplayText(item.lines.map((line) => line.slice(base)).join("\n"));
      if (!shown) return null;
      return <div key={itemIndex} className={`legal-analysis-item${itemIndex > 0 && item.divided ? " is-divided" : ""}`}>
        {shown.split("\n").map((line, lineIndex) => <span key={lineIndex} className="legal-analysis-line">{line}</span>)}
      </div>;
    })}
  </div>;
}

function Sections({ sections }: { sections: AnalysisSection[] }) {
  return <>{sections.map((section, index) => <div key={index} className="legal-analysis-section">
    {section.heading && <h3>{lawDisplayText(analysisStatus(section.heading))}</h3>}
    {section.list ? <ul className="legal-analysis-caution">
      {section.lines.map((line, lineIndex) => <li key={lineIndex}>{lawDisplayText(analysisStatus(line))}</li>)}
    </ul> : <SectionLines lines={section.lines} />}
  </div>)}</>;
}

function AxisLabel({ label }: { label: string }) {
  const match = /(.+?)(\([^()]*\)|（[^（）]*）)$/u.exec(label);
  return <span className="legal-analysis-axis-label">
    {match ? <>{lawDisplayText(match[1])}<wbr /><span className="legal-analysis-axis-suffix">{lawDisplayText(match[2])}</span></> : lawDisplayText(label)}
  </span>;
}

type CitationTone = "success" | "warning" | "error" | "neutral";
/** Presentation of the parser's existing state; no count or verdict is derived here. */
const AXIS_TONE: Record<ImpactAxisState, CitationTone> = {
  found: "success", partial: "warning", law_only: "warning", failed: "error", none: "neutral", empty: "neutral", unknown: "neutral",
};
const BADGE_VARIANT = { success: "success", warning: "warning", error: "error", neutral: "secondary" } as const;
const FAILED_AXIS_NOTE = "조회에 실패한 자료 유형은 0건이 아니라 확인하지 못한 것입니다.";

function ToneIcon({ tone }: { tone: CitationTone }) {
  return tone === "success" ? <CheckCircle2 aria-hidden="true" /> : tone === "neutral" ? <CircleMinus aria-hidden="true" /> : <AlertCircle aria-hidden="true" />;
}

/** 인용 현황: one white box — title and summary badges, a 자료 유형 · 검색 결과 · 확인 내용 table, one scope note. */
function CitationStatus({ axes, total, notes }: Pick<ImpactMapPresentation, "axes" | "total" | "notes">) {
  const id = useId();
  const failed = axes.filter((axis) => axis.state === "failed").length;
  const summary: { tone: CitationTone; label: string; title: string }[] = [
    ...(total ? [{ tone: total.confirmedCount > 0 ? "success" as const : "neutral" as const, label: `확인 ${total.confirmedCount}건`, title: total.headline }] : []),
    ...(total ? [{ tone: total.pendingCount ? "warning" as const : "neutral" as const, label: `추가 확인 ${total.pendingCount}건`, title: "법령명 또는 조문 단위 일치의 추가 확인이 필요한 개별 자료" }] : []),
    ...(failed ? [{ tone: "error" as const, label: `조회 실패 ${failed}개 유형`, title: "조회하지 못한 자료 유형 · 0건을 뜻하지 않습니다" }] : []),
  ];
  const otherNotes = [...notes, ...(total?.lines ?? [])].filter((note) => !(failed && (note === FAILED_AXIS_NOTE || note === "조회에 실패한 자료 유형은 0건이 아니라 확인하지 못한 상태입니다.")));
  return <section className="legal-analysis-section impact-citations" aria-labelledby={`${id}-title`}>
    <header className="impact-citations-head">
      <AnalysisResultCard
        status={failed || total?.pendingCount ? "확인 필요" : total?.confirmedCount ? "확인됨" : "미확인"}
        title={<h3 id={`${id}-title`}>인용 현황</h3>}
        help="이 조문을 인용한 판례·헌재 결정례·법령해석례·행정심판례와 이 법령을 언급한 자치법규 확인"
        meta="인용 현황 조회 · 법적 영향의 판단이 아닙니다"
        tone={failed || total?.pendingCount ? "unknown" : total?.confirmedCount ? "verified" : "muted"}
      />
      {summary.length > 0 && <div className="impact-citations-summary">
        {summary.map((item) => <Badge key={item.label} variant={BADGE_VARIANT[item.tone]} data-tone={item.tone} title={item.title} aria-label={item.title === total?.headline ? item.title : `${item.label} · ${item.title}`}>
          <ToneIcon tone={item.tone} />{item.label}
        </Badge>)}
      </div>}
    </header>
    <table className="legal-analysis-axes impact-citations-table">
      <thead><tr><th scope="col">자료 유형</th><th scope="col">검색 결과</th><th scope="col">확인 내용</th></tr></thead>
      <tbody>{axes.map((axis) => {
        const tone = AXIS_TONE[axis.state];
        return <tr key={axis.label} className={axis.state === "failed" ? "is-failed" : undefined} data-state={axis.state}>
          <th scope="row"><AxisLabel label={axis.label} /></th>
          <td><Badge variant={BADGE_VARIANT[tone]} data-tone={tone} className="impact-citation-result"><ToneIcon tone={tone} />{axis.headline}</Badge></td>
          <td className="impact-citation-detail">{axis.detail ?? (axis.state === "empty" ? "검색 결과가 없습니다." : "")}</td>
        </tr>;
      })}</tbody>
    </table>
    {otherNotes.length > 0 && <Alert variant="info" className="impact-citations-note">
      <Info aria-hidden="true" />
      <AlertDescription>
        <ul>{otherNotes.map((line) => <li key={line}>{line}</li>)}</ul>
      </AlertDescription>
    </Alert>}
  </section>;
}

export function AnalysisResult({ data, request, completedAt, onRelatedSearch }: { data: LawAnalysisData; request: LawAnalysisRequest; completedAt: number; onRelatedSearch?: (search: RelatedSearch) => void }) {
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
      claimSupport={data.claimSupport}
    />;
  } else if (data.mode === "cite_check") {
    const result = citeCheckResult(data.text);
    const detailStart = result.target.findIndex((line) => /^\s*(?:판시사항|판결요지|참조조문|참조판례)\s*:/u.test(line));
    const targetSummary = detailStart < 0 ? result.target : result.target.slice(0, detailStart);
    const targetDetails = detailStart < 0 ? [] : result.target.slice(detailStart);
    body = <>
      {!result.verdict && result.title && <h3 className="legal-analysis-title">{analysisTitle(result.title)}</h3>}
      {result.verdict && <AnalysisResultCard
        status={result.verdict.tone === "critical" ? "확인 필요" : "미확인"}
        title={<h3 className="legal-analysis-title">{result.title ? analysisTitle(result.title) : "후속 판례 인용 확인"}</h3>}
        help={<Lines lines={result.verdict.lines} />}
        tone={result.verdict.tone}
      />}
      <Lines lines={targetSummary} />
      {result.limitation.length > 0 && <Lines lines={result.limitation.map((line) => `⚠️ 한계: ${line}`)} />}
    </>;
    source = <details className="law-detail-source">
      <SourceToggleSummary label="근거 보기" openLabel="근거 접기" />
      <p className="law-search-note">대상 판례 정보와 후속 인용·본문 확인 결과입니다. 판결문 원문은 포함되지 않습니다</p>
      <Lines lines={targetDetails} />
      {result.sections.length > 0 ? <Sections sections={result.sections} />
        : <p className="law-search-note">제공된 후속 판례 목록 없음</p>}
    </details>;
  } else if (data.mode === "impact_map") {
    const view = impactMapPresentation(data.text);
    const sourceSections = view.sources.filter((section) => !/\[(?:NOT_FOUND|FAILED|ERROR|UPSTREAM_NO_DATA)\]/u.test(section.heading ?? "") && section.lines.length > 0);
    const sourceFailures = view.sources.filter((section) => !sourceSections.includes(section));
    const references = view.axes.filter((axis) => axis.items.length > 0);
    const related = view.related.filter((item) => item.domain && item.query.trim());
    body = <>
      {view.title && <h3 className="legal-analysis-title">{analysisTitle(view.title)}</h3>}
      {view.law && <p className="legal-analysis-lines">법령: {lawDisplayText(view.law)}</p>}
      <Sections sections={[...sourceFailures, ...view.other]} />
      {view.axes.length > 0 ? <CitationStatus axes={view.axes} total={view.total} notes={view.notes} />
        : view.total && <div className="legal-analysis-section">
          <h3>{view.total.headline}</h3>
          <Lines lines={view.total.lines} />
        </div>}
      {view.citedLaws.length > 0 && <Sections sections={[{ heading: `이 조문이 인용한 다른 법령 ${view.citedLaws.length}건`, lines: view.citedLaws }]} />}
      {related.length > 0 && onRelatedSearch && <div className="legal-analysis-section">
        <h3>관련 자료 검색</h3>
        <div className="law-related-actions">
          {related.map((item) => <Button variant="link" key={item.query + item.label} type="button" className="h-auto w-fit max-w-full justify-self-start justify-start whitespace-normal px-0 text-left" onClick={() => onRelatedSearch({ query: item.query, domain: item.domain! })}>
            {item.label} · {item.domain === "precedent" ? "판례 검색" : "해석례 검색"}
          </Button>)}
        </div>
      </div>}
    </>;
    source = <details className="law-detail-source">
      <SourceToggleSummary label="근거·원문 보기" openLabel="근거·원문 접기" />
      {sourceSections.length > 0
        ? <LawTextBlock className="legal-analysis-raw" text={sourceSections.map((section) => `${section.heading}\n${section.lines.join("\n")}`).join("\n\n")} />
        : <p className="law-search-note">조회된 조문 원문은 이 결과에 포함되지 않음</p>}
      {references.length > 0 && <Sections sections={references.map((axis) => ({ heading: `${axis.label} · 조회된 항목`, lines: axis.items }))} />}
    </details>;
  } else {
    const parsed = applicableLawPresentation(data.text, data.temporal);
    body = <ApplicableLawResult key={`${request.mode === "applicable_law" ? `${request.lawName}/${request.date}/${request.jo ?? ""}` : ""}/${completedAt}`} parsed={parsed} request={request.mode === "applicable_law" ? request : undefined} />;
  }
  return <div className="legal-analysis-output" data-mode={data.mode} data-markers={data.markers.join(" ")}>
    {body}
    {source}
    <p className="legal-analysis-note">{RESULT_NOTE}</p>
  </div>;
}

function ApplicableLawResult({ parsed, request }: {
  parsed: ApplicableLawPresentation;
  request?: Extract<LawAnalysisRequest, { mode: "applicable_law" }>;
}) {
  const [loaded, setLoaded] = useState<{ key: string; outcome: LawTextOutcome } | null>(null);
  const article = request?.jo ?? parsed.jo;
  const selected = parsed.selected;
  const mst = selected?.mst ?? parsed.mst;
  const referenceDate = request?.date.replace(/-/gu, "") ?? parsed.referenceDate;
  const effectiveDate = selected?.effectiveDate;
  const promulgationDate = selected?.promulgationDate;
  const identity = `${mst ?? ""}/${referenceDate ?? ""}/${effectiveDate ?? ""}/${promulgationDate ?? ""}/${article ?? ""}`;
  const source = loaded?.key === identity ? loaded.outcome : null;

  useEffect(() => {
    if (!mst || !referenceDate || !effectiveDate) return;
    const controller = new AbortController();
    void (async () => {
      let outcome: LawTextOutcome;
      try {
        const response = await fetch("/api/law/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mst, efYd: referenceDate, expectedEffectiveDate: effectiveDate,
            ...(promulgationDate ? { expectedPromulgationDate: promulgationDate } : {}),
            ...(article ? { jo: article } : {}),
          }),
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        outcome = lawTextOutcome(response.ok, body);
      } catch {
        outcome = { kind: "error", message: "기준일 원문을 확보하지 못했습니다." };
      }
      if (!controller.signal.aborted) setLoaded({ key: identity, outcome });
    })();
    return () => controller.abort();
  }, [mst, referenceDate, effectiveDate, promulgationDate, article, identity]);

  const hasSource = source?.kind === "found" && Boolean(source.data.text.trim())
    && source.data.effectiveDate?.replace(/\D/gu, "") === effectiveDate
    && (!promulgationDate || source.data.promulgationDate?.replace(/\D/gu, "") === promulgationDate)
    && (!selected?.lawName || source.data.name === selected.lawName);
  const waiting = Boolean(mst && referenceDate && effectiveDate && !source);
  const sourceLabel = hasSource && source.data.mode === "toc" ? "법령 목차" : "기준일 적용 법령 원문";
  const future = parsed.future;
  return <>
    <div className="legal-analysis-section">
      <h3 className="legal-analysis-title">{request?.lawName ?? selected?.lawName ?? "시점별 적용 법령"}</h3>
      <p className="legal-analysis-lines">기준일: {request?.date ?? parsed.referenceDate ?? "확인되지 않음"}{article ? ` · ${article}` : ""}</p>
    </div>
    <AnalysisResultCard
      status={hasSource ? "확인됨" : waiting ? "확인 중" : "미확인"}
      title={selected?.line ?? "기준일에 해당하는 판본을 확인하지 못했습니다."}
      help={hasSource ? "기준일에 시행 중인 법령입니다." : waiting ? "선택 판본과 기준일 원문의 일치 여부를 확인하고 있습니다." : "선택 판본과 기준일 원문의 일치를 확인하지 못했습니다."}
      meta="선택 판본"
      tone={hasSource ? "verified" : "unknown"}
    />
    {(future.count > 0 || future.error) && <details className="law-detail-source">
      <SourceToggleSummary label={`${future.complete ? `향후 시행 예정 버전 ${future.count}건` : `향후 시행 예정 버전 · 확인된 목록 ${future.versions.length}건`}${future.versions[0] ? ` · ${future.complete ? "가장 빠른 시행 예정일:" : "제공된 시행일:"} ${future.versions[0].effectiveDate.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1.$2.$3")}` : ""}`} openLabel="향후 시행 예정 버전 접기" />
      {future.versions.map((version) => <div className="legal-analysis-section" key={`${version.mst ?? ""}/${version.effectiveDate}`}>
        <Lines lines={[version.line]} />
        <FutureLawSource key={`${version.mst ?? ""}/${version.effectiveDate}/${article ?? ""}`} version={version} article={article} lawName={selected?.lawName ?? request?.lawName} />
      </div>)}
      {future.error ? <p className="law-search-note" role="status">향후 예정 판본 조회에 실패했습니다. 전체 예정 판본과 가장 빠른 시행일을 확정할 수 없습니다.</p>
        : !future.complete && <p className="law-search-note">제공된 예정 판본 정보만 표시합니다. 전체 목록과 가장 빠른 시행일은 추가 확인이 필요합니다.</p>}
    </details>}
    {!article && <p className="law-search-note">조문을 지정하지 않아 법령 판본만 확인합니다. 개별 조문의 적용 여부는 확인하지 않았습니다.</p>}
    {article && hasSource && source.data.mode === "toc" && <p className="law-search-note">요청 조문의 원문은 제공되지 않아 법령 목차만 표시합니다.</p>}
    <details className="law-detail-source">
      <SourceToggleSummary label={sourceLabel} openLabel={`${sourceLabel} 접기`} />
      {waiting ? <p className="law-search-note" role="status">기준일 원문을 불러오는 중…</p>
        : hasSource ? <><LawTextBlock className="legal-analysis-raw" text={source.data.text} /><OfficialSourceLinks text={source.data.text} lawName={source.data.name} version={selected} /></>
          : <p className="law-search-note" role="status">기준일 원문을 확보하지 못했습니다. 다른 시점의 원문으로 대체하지 않습니다.</p>}
      {parsed.excerpts.length > 0 && <Sections sections={parsed.excerpts.filter((section) => section.heading !== "조문 원문")} />}
    </details>
    <Sections sections={parsed.sections.filter((section) => !/^(?:기준일에 시행 중이던 버전|기준일 시행 조문)/u.test(section.heading ?? ""))} />
    <div className="legal-analysis-section">
      <p className="law-search-note">적용 법령은 행위·처분 시점과 부칙 등에 따라 달라질 수 있습니다.</p>
      {parsed.cautions.length > 0 && <details className="law-detail-source">
        <SourceToggleSummary label="법 적용 시 주의사항" openLabel="주의사항 접기" />
        <Sections sections={parsed.cautions} />
      </details>}
    </div>
  </>;
}

/** Historical route documented by the official LAW OPEN DATA 한글주소 contract. */
function OfficialSourceLinks({ text, lawName, version }: { text: string; lawName?: string; version?: ApplicableLawVersion }) {
  const urls = [...new Set(text.match(/https:\/\/(?:www\.)?law\.go\.kr\/[^\s<>"')\]]+/gu) ?? [])];
  if (!urls.length && lawName && version && /^\d{8}$/u.test(version.effectiveDate)
    && /^\d{8}$/u.test(version.promulgationDate ?? "") && /^\d+$/u.test(version.promulgationNumber ?? "")) {
    urls.push(`https://www.law.go.kr/법령/${encodeURIComponent(lawName.replace(/\s+/gu, ""))}/(${version.effectiveDate},${version.promulgationNumber},${version.promulgationDate})`);
  }
  return urls.length ? <p className="law-search-note">{urls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="law-search-link">국가법령정보센터 공식 출처</a>)}</p> : null;
}

function FutureLawSource({ version, article, lawName }: { version: ApplicableLawVersion; article?: string; lawName?: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ identity: string; outcome: LawTextOutcome } | null>(null);
  const { mst, effectiveDate, promulgationDate } = version;
  const identity = `${mst ?? ""}/${effectiveDate}/${promulgationDate ?? ""}/${article ?? ""}/${lawName ?? ""}`;
  const source = loaded?.identity === identity ? loaded.outcome : null;
  useEffect(() => {
    if (!open || !mst || source) return;
    const controller = new AbortController();
    void (async () => {
      let outcome: LawTextOutcome;
      try {
        const response = await fetch("/api/law/text", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mst, efYd: effectiveDate, expectedEffectiveDate: effectiveDate,
            ...(promulgationDate ? { expectedPromulgationDate: promulgationDate } : {}),
            ...(article ? { jo: article } : {}),
          }), signal: controller.signal,
        });
        outcome = lawTextOutcome(response.ok, await response.json().catch(() => null));
      } catch {
        outcome = { kind: "error", message: "예정 버전 원문을 확보하지 못했습니다." };
      }
      if (!controller.signal.aborted) setLoaded({ identity, outcome });
    })();
    return () => controller.abort();
  }, [open, mst, effectiveDate, promulgationDate, article, identity, source]);
  const confirmed = source?.kind === "found" && Boolean(source.data.text.trim())
    && source.data.effectiveDate?.replace(/\D/gu, "") === effectiveDate
    && (!promulgationDate || source.data.promulgationDate?.replace(/\D/gu, "") === promulgationDate)
    && (!lawName || source.data.name === lawName);
  const label = confirmed && source.data.mode === "toc" ? "예정 버전 법령 목차" : "예정 버전 공식 원문";
  return <details className="law-detail-source" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <SourceToggleSummary label={label} openLabel={`${label} 접기`} />
    {open && (mst && !source ? <p className="law-search-note" role="status">예정 버전 원문을 불러오는 중…</p>
      : confirmed ? <><LawTextBlock className="legal-analysis-raw" text={source.data.text} /><OfficialSourceLinks text={source.data.text} lawName={source.data.name} version={version} /></>
        : <p className="law-search-note" role="status">예정 버전 원문을 확보하지 못했습니다. 다른 시행일의 원문으로 대체하지 않습니다.</p>)}
  </details>;
}
