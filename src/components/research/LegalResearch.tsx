"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AMENDMENT_SCENARIOS, DISPUTE_DOMAINS, EMPTY_RESEARCH_DRAFT, LAW_RESEARCH_DOCUMENT_MAX_CHARS, LAW_RESEARCH_DOCUMENT_MIN_CHARS,
  LAW_RESEARCH_ERROR, LAW_RESEARCH_NAME_MAX_CHARS, LAW_RESEARCH_QUERY_MAX_CHARS, LAW_RESEARCH_TASKS, lawResearchOutcome, lawResearchRequestFor,
  type AmendmentScenario, type DisputeDomain, type LawResearchData, type LawResearchDraft, type LawResearchOutcome,
  type LawResearchRequest, type LawResearchTask, type ResearchInterpretation,
} from "@/lib/law-research";
import { isSupportingSection, researchResult, type ResearchDecision, type ResearchSection } from "@/lib/law-research-parse";
import { lawDisplayText } from "@/lib/law-display";
import { orderByRelevance, type ResearchEnrichment } from "@/lib/research-relevance";
import { LawTextBlock } from "./LawTextBlock";
import { ContractReviewResult } from "./ContractReviewResult";
import { SourceToggleSummary } from "./SourceToggleSummary";
import "./legal-analysis.css";

interface TaskResult {
  request: LawResearchRequest;
  outcome: LawResearchOutcome | null;
  loading: boolean;
}

const TASK_HELP: Record<LawResearchTask, { description: string; placeholder: string }> = {
  full_research: { description: "상황을 설명하면 관련 쟁점과 확인된 법령·판례를 구분해 보여줍니다. 확인되지 않은 사실은 판단하지 않습니다.", placeholder: "예: 회사에서 업무와 관련해 지속적으로 모욕을 당했는데 어떤 법적 기준을 살펴봐야 하나요?" },
  law_system: { description: "한 법령의 법률·시행령·시행규칙 관계와 관련 조문을 확인합니다.", placeholder: "예: 개인정보 보호법 제38조와 시행령의 관계" },
  action_basis: { description: "처분 또는 허가의 근거 조문과 확인 가능한 불복 자료를 찾습니다.", placeholder: "예: 식품위생법상 영업정지의 근거와 요건" },
  dispute_prep: { description: "쟁송에 참고할 법령, 판례, 결정례를 자료별로 나눠 살펴봅니다.", placeholder: "예: 부당해고 구제 신청 관련 판례와 결정례" },
  amendment_track: { description: "법령의 개정 이력이나 지정한 두 시점의 조문 변화를 확인합니다.", placeholder: "예: 근로기준법 제60조 개정 내용" },
  ordinance_compare: { description: "두 지역의 자치법규를 같은 주제로 조회합니다. 비교 내용은 양쪽 원문이 확인된 경우에만 제시합니다.", placeholder: "예: 공영주차장 감면 기준" },
  procedure_detail: { description: "절차의 근거 조문과 제출 서식을 찾아 확인합니다.", placeholder: "예: 행정심판 청구 절차와 제출서류" },
  document_review: { description: "입력한 문서의 조항별 쟁점과 확인된 근거를 검토합니다.", placeholder: "계약서 또는 약관 등의 내용을 붙여 넣으세요." },
};

const RESULT_NOTE = "법적 판단이 필요한 경우 국가법령정보센터 원문과 관련 전문가 검토가 필요할 수 있습니다.";

export function LegalResearch() {
  const [task, setTask] = useState<LawResearchTask>("full_research");
  const [draft, setDraft] = useState<LawResearchDraft>(EMPTY_RESEARCH_DRAFT);
  const [results, setResults] = useState<Partial<Record<LawResearchTask, TaskResult>>>({});
  const [regions, setRegions] = useState<[string, string]>(["", ""]);
  const requests = useRef(new Map<LawResearchTask, AbortController>());

  useEffect(() => {
    const pending = requests.current;
    return () => pending.forEach((controller) => controller.abort());
  }, []);

  const run = useCallback(async (request: LawResearchRequest) => {
    requests.current.get(request.task)?.abort();
    const controller = new AbortController();
    requests.current.set(request.task, controller);
    setResults((current) => ({ ...current, [request.task]: { request, outcome: null, loading: true } }));
    let outcome: LawResearchOutcome;
    try {
      const response = await fetch("/api/law/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      outcome = lawResearchOutcome(response.ok, body);
    } catch {
      outcome = { kind: "error", message: LAW_RESEARCH_ERROR };
    }
    if (controller.signal.aborted) return;
    requests.current.delete(request.task);
    setResults((current) => ({ ...current, [request.task]: { request, outcome, loading: false } }));
  }, []);

  /** Leaving a task cancels its in-flight chain; finished results stay for when the user comes back. */
  function changeTask(next: LawResearchTask) {
    const pending = requests.current.get(task);
    if (pending) {
      pending.abort();
      requests.current.delete(task);
      setResults((current) => {
        const copy = { ...current };
        delete copy[task];
        return copy;
      });
    }
    setTask(next);
  }

  const update = <K extends keyof LawResearchDraft>(key: K, value: LawResearchDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const current = results[task];
  const loading = current?.loading === true;
  const baseRequest = lawResearchRequestFor(task, draft);
  const regionNames = regions.map((region) => region.trim());
  const regionError = task === "ordinance_compare" && (regionNames.some((region) => !region) || regionNames[0] === regionNames[1]);
  const comparedQuery = `${draft.query.trim()}\n비교 대상 지역: ${regionNames.join(" / ")}`;
  const comparisonTooLong = task === "ordinance_compare" && comparedQuery.length > LAW_RESEARCH_QUERY_MAX_CHARS;
  const request = baseRequest?.task === "ordinance_compare"
    ? !regionError && !comparisonTooLong ? { ...baseRequest, query: comparedQuery } : null
    : baseRequest;
  const isDocument = task === "document_review";
  const reversedDates = task === "amendment_track" && draft.scenario === "time_travel" && draft.fromDate && draft.toDate && draft.fromDate > draft.toDate;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (request && !loading) void run(request);
  }

  return <div className="legal-analysis legal-research">
    <form className="legal-analysis-form" onSubmit={submit} aria-label="종합 리서치 입력">
      <div className="legal-analysis-fields legal-research-options">
        <label htmlFor="research-task">리서치 유형
          <select id="research-task" value={task} onChange={(event) => changeTask(event.target.value as LawResearchTask)}>
            {LAW_RESEARCH_TASKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {task === "dispute_prep" && <label htmlFor="research-domain">분야
          <select id="research-domain" value={draft.domain} onChange={(event) => update("domain", event.target.value as DisputeDomain | "")}>
            {DISPUTE_DOMAINS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>}
        {task === "amendment_track" && <label htmlFor="research-scenario">추적 방식
          <select id="research-scenario" value={draft.scenario} onChange={(event) => update("scenario", event.target.value as AmendmentScenario | "")}>
            <option value="">자동</option>
            {AMENDMENT_SCENARIOS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>}
      </div>
      <p className="legal-research-description">{TASK_HELP[task].description}</p>

      {isDocument ? <>
        <label htmlFor="research-document">검토할 문서 내용</label>
        <textarea id="research-document" value={draft.text} rows={10} maxLength={LAW_RESEARCH_DOCUMENT_MAX_CHARS} placeholder={TASK_HELP.document_review.placeholder} onChange={(event) => update("text", event.target.value)} aria-describedby="research-document-help" />
        <p id="research-document-help" className="legal-analysis-help">
          <span className="legal-analysis-count">{draft.text.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_DOCUMENT_MAX_CHARS.toLocaleString("ko-KR")}자 · 최소 {LAW_RESEARCH_DOCUMENT_MIN_CHARS}자</span>
        </p>
      </> : <>
        <label htmlFor="research-query">질문 또는 검색어</label>
        <textarea id="research-query" value={draft.query} rows={3} maxLength={LAW_RESEARCH_QUERY_MAX_CHARS} placeholder={TASK_HELP[task].placeholder} onChange={(event) => update("query", event.target.value)} aria-describedby="research-query-help"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <p id="research-query-help" className="legal-analysis-help legal-research-help-row">
          {task === "amendment_track" && <label className="legal-research-switch">
            전체 개정 이력 포함
            <input type="checkbox" role="switch" checked={draft.includeHistory} onChange={(event) => update("includeHistory", event.target.checked)} />
          </label>}
          <span className="legal-analysis-count">{draft.query.length.toLocaleString("ko-KR")} / {LAW_RESEARCH_QUERY_MAX_CHARS.toLocaleString("ko-KR")}자</span>
        </p>
      </>}

      {task === "law_system" && <label htmlFor="research-articles" className="legal-research-single">관련 조문 (선택)
        <input id="research-articles" type="text" value={draft.articles} placeholder="예: 제38조, 제39조" onChange={(event) => update("articles", event.target.value)} />
      </label>}
      {task === "ordinance_compare" && <label htmlFor="research-parent-law" className="legal-research-single">상위 법령 (선택)
        <input id="research-parent-law" type="text" value={draft.parentLaw} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder="예: 주차장법" onChange={(event) => update("parentLaw", event.target.value)} />
      </label>}
      {task === "ordinance_compare" && <>
        <div className="legal-analysis-fields legal-research-dates legal-research-regions">
          {regions.map((region, index) => <label key={index} htmlFor={`research-region-${index}`}>비교 지역 {index + 1}
            <input id={`research-region-${index}`} type="text" value={region} maxLength={LAW_RESEARCH_NAME_MAX_CHARS} placeholder={index ? "예: 부산광역시" : "예: 서울특별시"}
              onChange={(event) => setRegions((current) => current.map((value, position) => position === index ? event.target.value : value) as [string, string])} />
          </label>)}
        </div>
        {regionError && <p className="legal-research-input-note">서로 다른 비교 지역 두 곳을 각각 입력해 주세요. 지역명만 입력하고 질문은 위에 적으면 됩니다.</p>}
        {comparisonTooLong && <p className="legal-research-input-note">질문과 두 지역명을 합쳐 {LAW_RESEARCH_QUERY_MAX_CHARS.toLocaleString("ko-KR")}자 이내로 줄여 주세요.</p>}
      </>}
      {task === "amendment_track" && <>
        {draft.scenario === "time_travel" && <div className="legal-analysis-fields legal-research-dates">
          <label htmlFor="research-from">시작일
            <input id="research-from" type="date" value={draft.fromDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("fromDate", event.target.value)} />
          </label>
          <label htmlFor="research-to">종료일
            <input id="research-to" type="date" value={draft.toDate} min="1900-01-01" max="2100-12-31" onChange={(event) => update("toDate", event.target.value)} />
          </label>
          {reversedDates && <p className="law-search-error" role="alert">시작일은 종료일보다 늦을 수 없습니다.</p>}
        </div>}
      </>}

      <div className="legal-analysis-actions">
        <button type="submit" className="law-search-button" disabled={!request || loading}>
          {loading ? (isDocument ? "문서 검토 중…" : "리서치 중…") : isDocument ? "문서 검토" : "리서치 실행"}
        </button>
      </div>
    </form>

    {current && <section className="legal-analysis-result" aria-labelledby="research-result-heading" aria-busy={loading}>
      <h2 id="research-result-heading">{isDocument ? "검토 결과" : "리서치 결과"}</h2>
      {current.loading ? <p className="law-search-note" role="status">{isDocument ? "문서 검토 중…" : "리서치 중…"} 여러 자료를 함께 조회하므로 시간이 걸릴 수 있습니다.</p>
        : current.outcome?.kind === "error" ? <div className="decision-feedback" role="alert">
          <p className="law-search-error">{current.outcome.message}</p>
          <button type="button" className="law-search-link" onClick={() => void run(current.request)}>다시 시도</button>
        </div>
        : current.outcome?.kind === "missing" ? <div className="legal-analysis-missing" role="status">
          <header className="research-overview">
            <span className="research-eyebrow">조회 결과</span>
            <h3 className="legal-analysis-title">현재 조회 범위에서 자료를 찾지 못했습니다</h3>
            {current.request.task !== "document_review" && <div className="research-original"><span>원래 질문</span><p>{current.request.query}</p></div>}
            {current.request.task === "full_research" && current.outcome.data.interpretation?.original === current.request.query
              && <ResearchUnderstanding interpretation={current.outcome.data.interpretation} />}
            <p className="research-caution">자료가 조회되지 않았다는 뜻이지 관련 법령이나 판례가 존재하지 않는다는 뜻은 아닙니다. 다른 법령명이나 구체적인 쟁점으로 다시 확인해 주세요.</p>
          </header>
        </div>
        : current.outcome?.kind === "found" ? current.outcome.data.review
          ? <ContractReviewResult review={current.outcome.data.review} />
          : <ResearchResult data={current.outcome.data} request={current.request} />
        : null}
    </section>}
  </div>;
}

/** Search hits shown before the list folds; the rest of what the response contains stays one click away. */
const DECISION_PREVIEW = 3;
const ANNEX_PREVIEW = 5;

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = /^(\d{4})(\d{2})(\d{2})$/u.exec(value) ?? /^(\d{4})[.-](\d{1,2})[.-](\d{1,2})$/u.exec(value);
  if (!parts) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

/** Heading without the MCP's bracketed status markers, which the partial notice already reports. */
function sectionHeading(section: ResearchSection): string {
  const heading = lawDisplayText(section.heading?.replace(/\s*\[[^\]]*\]/gu, "")
    .replace(/^\s*(?:(?:STEP|단계)\s*\d+|(?:OPEN\s+)?API\s*(?:응답|오류|조회)?)\s*[:.)-]?\s*/iu, "").trim());
  const dates = /^Time Travel\s*[—–-]\s*(.+?)\s*\((\d{8})\s*↔\s*(\d{8})\)$/u.exec(heading);
  if (!dates) return heading;
  const from = formatDate(dates[2]);
  const to = formatDate(dates[3]);
  return `두 시점의 조문 비교 · ${dates[1]}${from && to ? ` (${from} → ${to})` : ""}`;
}

/** Source excerpts remain legible; agent-facing diagnostics do not become reader-facing claims. */
function readerText(text: string): string {
  return lawDisplayText(text.split(/\r?\n/u).filter((line) =>
    !/^\s*(?:(?:STEP\s*\d+|(?:OPEN\s+)?API\b)[\s:.)-]|\[(?:EXTERNAL_API_ERROR|REQUEST_TIMEOUT)\]|HTTP\s+\d{3}\b|검색\s*보정(?:\s*시도)?\s*[:：]|재시도(?:\s*제안)?\s*[:：]|힌트\s*[:：]|💡\s*다음\s*[:：]|사유\s*[:：]\s*\[(?:FAILED|NOT_FOUND)|⚠️\s*이 섹션은 조회 실패|특정\s*조문\s*조회\s*:\s*get_|.*법제처\s*API는\s*공백)/iu.test(line),
  ).join("\n"));
}

type ResearchGroup = "statutes" | "decisions" | "change" | "regional" | "forms" | "other";
const GROUP_LABELS: Record<Exclude<LawResearchTask, "document_review">, Partial<Record<ResearchGroup, string>>> = {
  full_research: { statutes: "추가 검색 결과 · 법령·조문 후보", decisions: "추가 검색 결과 · 판례·해석례 후보", other: "추가 조회 자료" },
  law_system: { statutes: "법령·조문", other: "법률·시행령·시행규칙 관계", decisions: "참고 결정" },
  action_basis: { statutes: "처분·허가의 법령 근거", decisions: "관련 불복·해석 자료", other: "추가 근거" },
  dispute_prep: { statutes: "관련 법령", decisions: "판례·결정례·재결례", other: "쟁송 참고 자료" },
  amendment_track: { change: "시점별 개정 내용", statutes: "관련 조문", other: "개정 참고 자료" },
  ordinance_compare: { regional: "지역별 자치법규", statutes: "상위 법령·조문", other: "비교 참고 자료" },
  procedure_detail: { forms: "제출 서식", statutes: "절차의 법령 근거", other: "절차·비용 자료" },
};
const GROUP_ORDER: Record<Exclude<LawResearchTask, "document_review">, ResearchGroup[]> = {
  full_research: ["statutes", "decisions", "other", "change", "regional", "forms"],
  law_system: ["other", "statutes", "decisions", "change", "regional", "forms"],
  action_basis: ["statutes", "decisions", "other", "change", "regional", "forms"],
  dispute_prep: ["decisions", "statutes", "other", "change", "regional", "forms"],
  amendment_track: ["change", "statutes", "other", "decisions", "regional", "forms"],
  ordinance_compare: ["regional", "statutes", "other", "decisions", "change", "forms"],
  procedure_detail: ["other", "forms", "statutes", "decisions", "change", "regional"],
};

function groupOf(section: ResearchSection, task: LawResearchTask): ResearchGroup {
  const heading = section.heading ?? "";
  if (section.kind === "law_articles") return task === "ordinance_compare"
    && (/조례|자치법규/u.test(heading) || section.articles?.some((article) => /조례|자치법규/u.test(article.law))) ? "regional" : "statutes";
  if (section.kind === "decision_search" || /판례|해석례|재결|심판례|결정례/u.test(heading)) return "decisions";
  if (section.kind === "annex" || /별표|서식/u.test(heading)) return "forms";
  if (task === "amendment_track" && /개정|신구|시점|이력|Time Travel/u.test(heading)) return "change";
  if (task === "ordinance_compare" && /자치법규|조례|지역/u.test(heading)) return "regional";
  if (/법령|조문|상위법/u.test(heading)) return "statutes";
  return "other";
}

function ResearchUnderstanding({ interpretation }: { interpretation: ResearchInterpretation }) {
  return <div className="research-understanding">
    <span className="research-eyebrow">질문 해석 · 출처의 법적 판단이 아닙니다</span>
    <p>{interpretation.situation}</p>
    {interpretation.issues.length > 0 && <div><strong>살펴볼 쟁점</strong><ul>{interpretation.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
    {interpretation.uncertainty && <p className="research-meta">{interpretation.uncertainty}</p>}
    {interpretation.followUp && <p className="research-meta">확인이 필요한 정보: {interpretation.followUp}</p>}
  </div>;
}

function DecisionList({ entries }: { entries: ResearchDecision[] }) {
  return <ul className="research-hits">{entries.map((entry) => {
    const meta = [entry.caseNumber && `사건번호 ${entry.caseNumber}`, entry.body, formatDate(entry.date)].filter(Boolean).join(" · ");
    return <li key={entry.id}>
      <strong>{lawDisplayText(entry.title ?? entry.caseNumber ?? "제목 없음")}</strong>
      {meta && <span className="research-meta">{lawDisplayText(meta)}</span>}
    </li>;
  })}</ul>;
}

/** Articles WorkLens looked up itself because a question term is in their title. */
function SupplementView({ supplement, hasArticles, excluded }: { supplement: NonNullable<ResearchEnrichment["supplement"]>; hasArticles: boolean; excluded?: Set<string> }) {
  const articles = supplement.articles.filter((article) => !excluded?.has(`${article.law}\u0000${article.jo}`));
  if (!articles.length) {
    if (supplement.articles.length || hasArticles || supplement.status === "not_searched") return null;
    return <div className="legal-analysis-section" data-kind="supplement" data-status={supplement.status}>
      <p className="research-meta">{supplement.status === "failed" ? "관련 조문 추가 조회에 실패했습니다." : "관련 법령을 충분히 확인하지 못했습니다."}</p>
    </div>;
  }
  return <div className="legal-analysis-section" data-kind="supplement" data-status={supplement.status}>
    <h3>질문 용어가 제목에 있는 조문 <span className="research-meta">{articles.length}건</span></h3>
    <p className="research-meta">질문의 용어가 조문 제목에 있는 조문을 법제처에서 추가로 조회했습니다.</p>
    <ul className="research-hits">{articles.map((article) => {
      const effective = formatDate(article.effectiveDate);
      return <li key={`${article.law}-${article.jo}`}>
        <strong>{article.law} {article.jo} {article.title}</strong>
        <LawTextBlock className="legal-analysis-lines" text={article.excerpt} />
        {effective && <span className="research-meta">출처 시행일 {effective}</span>}
      </li>;
    })}</ul>
  </div>;
}

const STATUS_NOTE: Record<Exclude<ResearchSection["status"], "available">, string> = {
  not_found: "검색된 관련 자료가 없습니다.",
  failed: "이 자료를 불러오지 못했습니다.",
  timeout: "조회가 완료되지 않았습니다.",
};

/** Top notice only for sections that failed or timed out; an empty search is a normal result. */
function partialNotice(sections: readonly ResearchSection[]): string | null {
  const failed = sections.some((section) => section.status === "failed");
  const timeout = sections.some((section) => section.status === "timeout");
  if (failed && timeout) return "일부 자료를 확인하지 못해 현재 조회된 결과만 표시합니다.";
  if (failed) return "일부 자료를 불러오지 못했습니다. 확인된 자료를 기준으로 결과를 표시합니다.";
  if (timeout) return "일부 자료 조회가 완료되지 않아 확인된 결과만 표시합니다.";
  return null;
}

function ResearchSectionView({ section, task, relevance, retried }: {
  section: ResearchSection; task: LawResearchData["task"]; relevance?: ResearchEnrichment["precedents"];
  retried?: ResearchEnrichment["interpretations"];
}) {
  const heading = sectionHeading(section);
  const className = `legal-analysis-section${section.unavailable ? " is-unavailable" : ""}`;
  if (section.status !== "available") {
    // The MCP's reason/hint lines address the calling agent; the reader gets one sentence (raw text stays in 원문 보기).
    const found = section.status === "not_found" && retried?.entries.length ? retried : undefined;
    return <div className={className} data-kind={section.kind} data-status={section.status}>
      {heading && <h3>{heading}{found && <span className="research-meta"> {found.entries.length}건</span>}</h3>}
      {found
        ? <>
          <p className="research-meta">별도 조회에서 찾은 후보 자료입니다. 사건 내용과의 관련성은 원문으로 확인해 주세요.</p>
          <DecisionList entries={found.entries} />
        </>
        : <p className="research-meta research-empty">{STATUS_NOTE[section.status]}</p>}
    </div>;
  }
  if (section.kind === "law_articles" && section.articles) {
    const articles = section.articles;
    const items = (from: number, to: number) => <ul className="research-hits">{articles.slice(from, to).map((article, index) => {
      const excerpt = readerText(article.excerpt);
      const effective = formatDate(article.effective);
      return <li key={`${article.law}-${article.jo}-${from + index}`}>
        <strong>{article.law} {article.jo}{article.title ? ` ${article.title}` : ""}</strong>
        {excerpt && <LawTextBlock className="legal-analysis-lines" text={excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt} />}
        {excerpt.length > 600 && <details className="law-detail-source research-more"><SourceToggleSummary label="조문 발췌 전체 보기" openLabel="조문 발췌 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>}
        {(effective || article.ministry) && <span className="research-meta">{[effective && `출처 시행일 ${effective}`, article.ministry].filter(Boolean).join(" · ")}</span>}
      </li>;
    })}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>검색된 조문 후보 <span className="research-meta">여기 표시한 {articles.length}건</span></h3>
      <p className="research-meta">검색 후보의 조문 발췌입니다. 실제 적용 여부는 해당 사실관계와 법령 원문을 대조해야 합니다.</p>
      {items(0, 3)}
      {articles.length > 3 && <details className="law-detail-source research-more"><SourceToggleSummary label={`나머지 조문 ${articles.length - 3}건 보기`} openLabel="나머지 조문 접기" />{items(3, articles.length)}</details>}
    </div>;
  }
  if (section.kind === "decision_search" && section.decisions) {
    const { total, entries } = section.decisions;
    const rated = relevance && entries.some((entry) => relevance[entry.id]);
    const ordered = rated ? orderByRelevance(entries, relevance) : entries;
    // Cases whose 판시사항/opening does not address the question are kept, folded, never deleted.
    const shown = rated ? ordered.filter((entry) => relevance![entry.id]?.rank !== "low") : ordered;
    const low = rated ? ordered.filter((entry) => relevance![entry.id]?.rank === "low") : [];
    const rest = shown.slice(DECISION_PREVIEW);
    return <div className={className} data-kind={section.kind}>
      <h3>{heading} <span className="research-meta">여기 표시한 후보 {entries.length}건{total !== undefined ? ` · 전체 검색 후보 총 ${total.toLocaleString("ko-KR")}건` : ""}</span></h3>
      {rated && <p className="research-meta">읽힌 판시사항과 질문의 관련성을 기준으로 정렬했습니다. 제목만으로 판단하지 않습니다.</p>}
      {shown.length > 0
        ? <DecisionList entries={shown.slice(0, DECISION_PREVIEW)} />
        : <p className="research-meta research-empty">관련성이 높은 판례를 충분히 확인하지 못했습니다.</p>}
      {rest.length > 0 && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`검색 결과 펼쳐보기 · ${rest.length}건 더`} openLabel="검색 결과 접기" />
        <DecisionList entries={rest} />
      </details>}
      {low.length > 0 && <details className="law-detail-source research-more" data-relevance="low">
        <SourceToggleSummary label={`질문과의 관련성을 확인하지 못한 판례 · ${low.length}건`} openLabel="관련성 미확인 판례 접기" />
        <DecisionList entries={low} />
      </details>}
    </div>;
  }
  if (section.kind === "annex" && section.annex) {
    const { total, entries } = section.annex;
    // For 절차·서식 the forms are the answer; elsewhere they are reference material.
    const preview = task === "procedure_detail" ? 10 : ANNEX_PREVIEW;
    const list = (items: typeof entries) => <ul className="research-hits">{items.map((item, index) => <li key={`${item.title}-${index}`}>
      <strong>{item.title}</strong>{item.law && <span className="research-meta">{item.law}</span>}
    </li>)}</ul>;
    return <div className={className} data-kind={section.kind}>
      <h3>{heading} <span className="research-meta">응답에 포함된 {entries.length}건{total !== undefined ? ` · 검색 후보 총 ${total.toLocaleString("ko-KR")}건` : ""}</span></h3>
      {list(entries.slice(0, preview))}
      {entries.length > preview && <details className="law-detail-source research-more">
        <SourceToggleSummary label={`목록 펼쳐보기 · ${entries.length - preview}건 더`} openLabel="목록 접기" />
        {list(entries.slice(preview))}
      </details>}
    </div>;
  }
  const text = readerText(section.lines.join("\n"));
  const lines = text.split("\n");
  const preview = lines.slice(0, 7).join("\n").slice(0, 800);
  const steps = task === "procedure_detail" && /절차|진행|신청|청구/u.test(heading) ? lines.flatMap((line) => {
    const match = /^\s*(\d{1,2})[.)]\s+(.{2,200})\s*$/u.exec(line);
    return match ? [{ number: match[1], text: match[2] }] : [];
  }) : [];
  const hierarchy = task === "law_system" && /3단 비교|법령 체계/u.test(heading) ? lines.flatMap((line) => {
    const match = /^\s*\[(법률|시행령|시행규칙)\]\s*(.+)$/u.exec(line);
    return match ? [{ level: match[1], content: match[2] }] : [];
  }) : [];
  return <div className={className} data-kind={section.kind}>
    {heading && <h3>{heading}</h3>}
    {hierarchy.length > 0 ? <dl className="research-hierarchy">{hierarchy.map((item, index) => <div key={index}><dt>{item.level}</dt><dd>{item.content}</dd></div>)}</dl>
      : steps.length >= 2 ? <ol className="research-steps">{steps.map((step, index) => <li key={`${step.number}-${index}`}>{step.text}</li>)}</ol>
        : text && <LawTextBlock className="legal-analysis-lines" text={text.length > preview.length ? `${preview}…` : preview} />}
    {(hierarchy.length > 0 || steps.length >= 2 || text.length > preview.length) && <details className="law-detail-source research-more"><SourceToggleSummary label="출처 내용 전체 보기" openLabel="출처 내용 접기" /><LawTextBlock className="legal-analysis-raw" text={text} /></details>}
  </div>;
}

function ResearchResult({ data, request }: { data: LawResearchData; request: LawResearchRequest }) {
  const result = researchResult(data.text);
  const notice = partialNotice(result.sections);
  const full = data.task === "full_research";
  const interpretation = full && data.interpretation?.original === (request.task === "document_review" ? "" : request.query) ? data.interpretation : undefined;
  const primary = result.sections.filter((section) => !isSupportingSection(section)
    && !/^\s*(?:STEP\s*\d+|(?:OPEN\s+)?API\b)/iu.test(section.heading ?? "")
    && (section.heading || readerText(section.lines.join("\n")))
    && (!full || groupOf(section, data.task) !== "other"));
  const supporting = result.sections.filter(isSupportingSection);
  const articleCount = result.sections.reduce((count, section) => count + (section.articles?.length ?? 0), 0);
  const caseCount = result.sections.reduce((count, section) => count + (section.decisions?.entries.length ?? 0), 0);
  const candidateCount = articleCount + caseCount + (data.enrichment?.supplement?.articles.length ?? 0) + (data.enrichment?.interpretations?.entries.length ?? 0);
  const hasUnparsedCandidates = primary.some((section) => section.status === "available"
    && /statutes|decisions/u.test(groupOf(section, data.task)) && !section.articles?.length && !section.decisions?.entries.length && readerText(section.lines.join("\n")));
  const hasCandidates = candidateCount > 0 || hasUnparsedCandidates;
  const taskGroups = GROUP_ORDER[data.task === "document_review" ? "full_research" : data.task];
  const allArticles = result.sections.filter((section) => section.status === "available").flatMap((section) => section.articles ?? []);
  const selectedArticleKeys = new Set(full ? (data.evidence?.articles ?? []).map((item) => `${item.law}\u0000${item.jo}`) : []);
  const selectedCaseIds = new Set(full ? data.evidence?.precedents ?? [] : []);
  const sourceArticles = [...allArticles, ...(data.enrichment?.supplement?.articles ?? []).map((article) => ({
    law: article.law, jo: article.jo, title: article.title, excerpt: article.excerpt, effective: article.effectiveDate,
  }))];
  const selectedArticles = [...new Map(sourceArticles.filter((article) => selectedArticleKeys.has(`${article.law}\u0000${article.jo}`) && readerText(article.excerpt))
    .map((article) => [`${article.law}\u0000${article.jo}`, article] as const)).values()];
  const selectedCases = [...new Map(result.sections.filter((section) => section.status === "available")
    .flatMap((section) => section.decisions?.entries ?? []).filter((entry) => selectedCaseIds.has(entry.id))
    .map((entry) => [entry.id, entry] as const)).values()];
  const evidenceStatus = selectedArticles.length + selectedCases.length ? data.evidence?.status : "unverified";
  const headline = evidenceStatus === "matched"
    ? notice ? "쟁점과 닿는 출처 내용을 찾았지만 조회가 완전하지 않습니다" : "쟁점과 닿는 출처 내용을 찾았습니다"
    : evidenceStatus === "partial" ? "일부 쟁점에 닿는 출처 내용만 찾았습니다"
      : hasCandidates ? "자료 후보는 있으나 쟁점과의 관련성이 확인되지 않았습니다"
        : notice ? "자료 조회가 완료되지 않았습니다" : "현재 확인 가능한 자료 후보가 없습니다";
  const visibleSelectedKeys = new Set(selectedArticles.map((article) => `${article.law}\u0000${article.jo}`));
  const visibleSelectedCaseIds = new Set(selectedCases.map((entry) => entry.id));
  const candidatePrimary: ResearchSection[] = full ? primary.flatMap((section) => {
    if (section.articles) {
      const articles = section.articles.filter((article) => !visibleSelectedKeys.has(`${article.law}\u0000${article.jo}`));
      return articles.length ? [{ ...section, articles }] : [];
    }
    if (section.decisions) {
      const entries = section.decisions.entries.filter((entry) => !visibleSelectedCaseIds.has(entry.id));
      return entries.length ? [{ ...section, decisions: { ...section.decisions, entries } }] : [];
    }
    return [section];
  }) : primary;
  const regionMatch = request.task === "ordinance_compare" && /\n비교 대상 지역: ([^\n/]+) \/ ([^\n/]+)$/u.exec(request.query);
  const regionNames = regionMatch ? [regionMatch[1].trim(), regionMatch[2].trim()] : [];
  const left = allArticles.filter((article) => regionNames[0] && article.law.includes(regionNames[0]) && article.title && readerText(article.excerpt));
  const right = allArticles.filter((article) => regionNames[1] && article.law.includes(regionNames[1]) && article.title && readerText(article.excerpt));
  const paired = left.flatMap((first) => {
    const second = right.find((entry) => entry.title === first.title && entry.law !== first.law);
    return second ? [{ first, second }] : [];
  }).slice(0, 8);
  const taskHeadlines: Record<Exclude<LawResearchTask, "full_research">, string> = {
    law_system: "법률과 하위 법령의 관계를 살펴보세요",
    action_basis: "처분·허가의 근거 후보를 살펴보세요",
    dispute_prep: "판례와 불복 자료를 살펴보세요",
    amendment_track: "조회된 시점별 개정 내용을 살펴보세요",
    ordinance_compare: paired.length ? "두 지역의 조문 발췌를 나란히 확인하세요" : "지역별 자치법규 자료를 살펴보세요",
    procedure_detail: "절차 근거와 서식을 살펴보세요",
    document_review: "문서 검토 결과",
  };
  const available = primary.some((section) => section.status === "available" && readerText(section.lines.join("\n")))
    || Boolean(data.enrichment?.supplement?.articles.length);
  const resultHeadline = full ? headline : !available ? notice ? "일부 조회를 완료하지 못했습니다" : "현재 조회된 자료가 없습니다"
    : taskHeadlines[data.task === "full_research" ? "document_review" : data.task];

  return <div className="legal-analysis-output" data-task={data.task}>
    <header className="research-overview">
      <span className="research-eyebrow">{LAW_RESEARCH_TASKS.find((item) => item.value === data.task)?.label} · 조회 결과</span>
      <h3 className="legal-analysis-title">{resultHeadline}</h3>
      {request.task !== "document_review" && <div className="research-original"><span>원래 질문</span><p>{request.task === "ordinance_compare" ? request.query.split("\n비교 대상 지역:")[0] : request.query}</p></div>}
      {interpretation && <ResearchUnderstanding interpretation={interpretation} />}
      {full && <p className="research-caution">{hasCandidates
        ? `${candidateCount ? `조회 응답에 조문 ${articleCount}건·사건 자료 ${caseCount}건이 포함됐습니다. ` : "아래 조회 내용은 검토 전 자료 후보입니다. "}${selectedArticles.length + selectedCases.length ? "아래 '확인한 근거'에 별도로 표시한 출처만 쟁점과의 내용 일치가 확인됐습니다. 나머지는 검색 후보이며, 구체적 사건의 법적 결론은 아닙니다." : "제목이나 검색 건수만으로 관련성이나 법적 결론을 확인할 수 없습니다."}`
        : "검색 결과가 없다는 뜻이지 관련 법령이나 판례가 존재하지 않는다는 뜻은 아닙니다."}</p>}
      {data.task === "ordinance_compare" && regionNames.length === 2 && <p className="research-caution">비교 대상: {regionNames.join(" · ")}. 두 지역의 조문이 모두 조회되지 않으면 차이·우열을 판단하지 않습니다.</p>}
    </header>
    {notice && <p className="legal-research-partial" role="note">{notice}</p>}
    {full && (selectedArticles.length > 0 || selectedCases.length > 0) && <section className="research-group research-selected" aria-label="확인한 근거">
      <h3>확인한 근거</h3>
      <p className="research-meta">법제처 조회 내용의 표현과 질문 쟁점이 맞닿는 자료입니다. 법령의 적용 여부, 판결의 결론이나 현행 상태까지 확인했다는 뜻은 아닙니다.</p>
      {selectedArticles.length > 0 && <div className="legal-analysis-section">
        <h3>조문에서 확인한 내용</h3>
        <ul className="research-hits">{selectedArticles.map((article) => {
          const excerpt = readerText(article.excerpt);
          const effective = formatDate(article.effective);
          return <li key={`${article.law}-${article.jo}`}>
            <strong>{article.law} {article.jo}{article.title ? ` ${article.title}` : ""}</strong>
            <LawTextBlock className="legal-analysis-lines" text={excerpt.length > 700 ? `${excerpt.slice(0, 700)}…` : excerpt} />
            {excerpt.length > 700 && <details className="law-detail-source research-more"><SourceToggleSummary label="조문 발췌 전체 보기" openLabel="조문 발췌 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>}
            {effective && <span className="research-meta">출처에 표시된 시행일 {effective}</span>}
          </li>;
        })}</ul>
      </div>}
      {selectedCases.length > 0 && <div className="legal-analysis-section">
        <h3>판례에서 확인한 내용</h3>
        <ul className="research-hits">{selectedCases.map((entry) => {
          const source = supporting.find((section) => section.kind === "detail" && section.lines.some((line) => line.trimStart().startsWith(`[${entry.id}]`)));
          const lines = source?.lines ?? [];
          const start = lines.findIndex((line) => line.trimStart().startsWith(`[${entry.id}]`));
          const next = lines.findIndex((line, index) => index > start && /^\[\d{1,32}\]/u.test(line.trim()));
          const excerpt = readerText(data.evidence?.precedentExcerpts?.[entry.id]
            ?? (start < 0 ? "" : lines.slice(start, next < 0 ? undefined : next).join("\n")));
          const date = formatDate(entry.date);
          return <li key={entry.id}>
            <strong>{lawDisplayText(entry.title ?? entry.caseNumber ?? `판례 ${entry.id}`)}</strong>
            <span className="research-meta">{[entry.caseNumber && `사건번호 ${entry.caseNumber}`, entry.body, date && `선고·회신 ${date}`].filter(Boolean).join(" · ")}</span>
            {excerpt
              ? <details className="law-detail-source research-more"><SourceToggleSummary label="판시사항 근거 보기" openLabel="판시사항 근거 접기" /><LawTextBlock className="legal-analysis-raw" text={excerpt} /></details>
              : <p className="research-meta">판시사항 발췌를 표시할 수 없습니다. 아래 조회 원자료도 대조해 주세요.</p>}
          </li>;
        })}</ul>
      </div>}
    </section>}
    {data.task === "ordinance_compare" && <section className="research-group" aria-label="조례 대조">
      <h3>확인된 조문 나란히 보기</h3>
      {paired.length ? <>
        <p className="research-meta">같은 제목으로 조회된 두 지역 조문의 발췌입니다. 동일한 법적 효과를 뜻하지 않습니다.</p>
        <div className="research-table-scroll"><table className="research-comparison"><thead><tr><th scope="col">조문 제목</th><th scope="col">{regionNames[0]}</th><th scope="col">{regionNames[1]}</th></tr></thead>
          <tbody>{paired.map(({ first, second }, index) => {
            const firstDate = formatDate(first.effective);
            const secondDate = formatDate(second.effective);
            return <tr key={`${first.title}-${index}`}><th scope="row">{first.title}</th>
              <td><strong>{first.law} {first.jo}</strong><LawTextBlock className="legal-analysis-lines" text={readerText(first.excerpt)} />{firstDate && <span className="research-meta">출처 시행일 {firstDate}</span>}</td>
              <td><strong>{second.law} {second.jo}</strong><LawTextBlock className="legal-analysis-lines" text={readerText(second.excerpt)} />{secondDate && <span className="research-meta">출처 시행일 {secondDate}</span>}</td></tr>;
          })}</tbody></table></div>
      </> : <p className="research-meta">양쪽 지역의 같은 주제 조문 원문이 함께 확인되지 않아 비교표를 만들지 않았습니다. 아래 지역별 조회 자료를 확인해 주세요.</p>}
    </section>}
    {taskGroups.map((group) => {
      const sections = candidatePrimary.filter((section) => groupOf(section, data.task) === group);
      const supplement = group === "statutes" && data.enrichment?.supplement
        && (data.enrichment.supplement.articles.some((article) => !visibleSelectedKeys.has(`${article.law}\u0000${article.jo}`)) || !data.enrichment.supplement.articles.length)
        ? data.enrichment.supplement : undefined;
      if (!sections.length && !supplement) return null;
      return <section key={group} className="research-group" data-group={group}>
        <h3>{GROUP_LABELS[data.task === "document_review" ? "full_research" : data.task][group] ?? "참고 자료"}</h3>
        {sections.map((section, index) => <ResearchSectionView key={index} section={section} task={data.task}
          relevance={data.enrichment?.precedents} retried={/해석례/u.test(section.heading ?? "") ? data.enrichment?.interpretations : undefined} />)}
        {supplement && <SupplementView supplement={supplement} hasArticles={articleCount > 0} excluded={visibleSelectedKeys} />}
      </section>;
    })}
    {supporting.length > 0 && <section className="legal-analysis-section research-supporting">
      <h3>상세 근거</h3>
      {supporting.map((section, index) => {
        const heading = sectionHeading(section) || "상세 자료";
        const label = section.kind === "law_toc" && section.toc
          ? `${section.toc.law ? `${lawDisplayText(section.toc.law)} ` : ""}전체 목차 · ${section.toc.count.toLocaleString("ko-KR")}개 조문`
          : heading;
        return <details key={index} className="law-detail-source" data-kind={section.kind}>
          <SourceToggleSummary label={label} openLabel={`${label} 접기`} />
          <LawTextBlock className="legal-analysis-raw" text={readerText(section.lines.join("\n"))} />
        </details>;
      })}
    </section>}
    <details className="law-detail-source research-source">
      <SourceToggleSummary label="조회 원자료 전체 보기" openLabel="조회 원자료 접기" />
      <p className="research-meta">출처의 원문 발췌와 시행 시점을 대조해 주세요. 검색 안내 문구는 제외했습니다.</p>
      <LawTextBlock className="legal-analysis-raw" text={readerText(data.text)} />
    </details>
    <p className="legal-analysis-note">조회 경로: {result.sources.map((source) => source.replace(" OPEN API", "")).join(" · ")}. {RESULT_NOTE}</p>
  </div>;
}
