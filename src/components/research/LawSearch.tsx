"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  formatLawDate, LAW_ARTICLE_PATTERN, LAW_FALLBACK_ERROR, LAW_TEXT_FALLBACK_ERROR,
  lawOutcome, lawStatusTone, lawTextIdentifier, lawTextOutcome,
  type LawEntry, type LawOutcome, type LawText, type LawTextOutcome,
} from "@/lib/law-search";
import { DecisionSearch, type LinkedDecisionSearch } from "./DecisionSearch";
import { LegalAnalysis, type LinkedAnalysis } from "./LegalAnalysis";
import "./law-search.css";

type ResearchView = "law" | "decisions" | "analysis";

export function LawSearch() {
  const [view, setView] = useState<ResearchView>("law");
  const [linkedRequest, setLinkedRequest] = useState<LinkedDecisionSearch | null>(null);
  const [linkedAnalysis, setLinkedAnalysis] = useState<LinkedAnalysis | null>(null);
  const returnFocus = useRef<string | null>(null);

  function relatedDecisions(law: LawEntry, jo: string) {
    setLinkedRequest({ query: `${law.name} ${jo}`, lawName: law.name, jo });
    setView("decisions");
    requestAnimationFrame(() => document.getElementById("decision-query")?.focus());
  }

  function returnToLaw() {
    setView("law");
    requestAnimationFrame(() => document.getElementById("related-decisions")?.focus());
  }

  /** Opens an analysis from structured law/decision state; `focusId` is the trigger to return to. */
  function openAnalysis(request: LinkedAnalysis, focusId: string) {
    returnFocus.current = focusId;
    setLinkedAnalysis(request);
    setView("analysis");
  }

  function returnFromAnalysis(origin: LinkedAnalysis["origin"]) {
    setView(origin);
    const focusId = returnFocus.current;
    if (focusId) requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }

  return <div className="law-research">
    <div className="law-view-switch" aria-label="법령 자료 유형">
      <button type="button" aria-pressed={view === "law"} onClick={() => setView("law")}>법령 검색</button>
      <button type="button" aria-pressed={view === "decisions"} onClick={() => { setLinkedRequest(null); setView("decisions"); }}>판례·결정례</button>
      <button type="button" aria-pressed={view === "analysis"} onClick={() => { setLinkedAnalysis(null); setView("analysis"); }}>검증·분석</button>
    </div>
    <div hidden={view !== "law"}><LawPane onRelated={relatedDecisions} onAnalysis={openAnalysis} /></div>
    <div hidden={view !== "decisions"}>
      <DecisionSearch linkedRequest={linkedRequest} onReturnToLaw={returnToLaw}
        onCiteCheck={(caseNumber) => openAnalysis({ mode: "cite_check", caseNumber, origin: "decisions" }, "decision-cite-check")} />
    </div>
    <div hidden={view !== "analysis"}><LegalAnalysis linkedRequest={linkedAnalysis} onReturn={returnFromAnalysis} /></div>
  </div>;
}

interface LawPaneProps {
  onRelated: (law: LawEntry, jo: string) => void;
  onAnalysis: (request: LinkedAnalysis, focusId: string) => void;
}

function LawPane({ onRelated, onAnalysis }: LawPaneProps) {
  const [query, setQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [outcome, setOutcome] = useState<LawOutcome | null>(null);
  const [selected, setSelected] = useState<LawEntry | null>(null);
  const [overview, setOverview] = useState<LawText | null>(null);
  const [detail, setDetail] = useState<LawTextOutcome | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeJo, setActiveJo] = useState<string | undefined>();
  const [articleInput, setArticleInput] = useState("");
  const [articleInputError, setArticleInputError] = useState(false);
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    searchRequest.current?.abort();
    detailRequest.current?.abort();
  }, []);

  async function search(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || searchRequest.current) return;
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearchLoading(true);
    try {
      const response = await fetch("/api/law", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!controller.signal.aborted) setOutcome(lawOutcome(response.ok, body));
    } catch {
      if (!controller.signal.aborted) setOutcome({ kind: "error", message: LAW_FALLBACK_ERROR });
    } finally {
      if (searchRequest.current === controller) {
        searchRequest.current = null;
        setSearchLoading(false);
      }
    }
  }

  async function loadText(law: LawEntry, jo?: string) {
    const identifier = lawTextIdentifier(law);
    if (!identifier) return;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setActiveJo(jo);
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await fetch("/api/law/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jo ? { ...identifier, jo } : identifier),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      const result = lawTextOutcome(response.ok, body);
      if (!jo && result.kind === "found") setOverview(result.data);
      setDetail(result);
    } catch {
      if (!controller.signal.aborted) setDetail({ kind: "error", message: LAW_TEXT_FALLBACK_ERROR });
    } finally {
      if (detailRequest.current === controller) {
        detailRequest.current = null;
        setDetailLoading(false);
      }
    }
  }

  function openLaw(law: LawEntry) {
    if (!lawTextIdentifier(law)) return;
    setSelected(law);
    setOverview(null);
    setArticleInput("");
    setArticleInputError(false);
    void loadText(law);
  }

  function backToResults() {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetailLoading(false);
    setSelected(null);
    setDetail(null);
    setOverview(null);
    setArticleInputError(false);
  }

  function backToOverview() {
    if (!overview) return;
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetailLoading(false);
    setActiveJo(undefined);
    setDetail({ kind: "found", data: overview });
    setArticleInputError(false);
  }

  function articleSearch(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const jo = articleInput.trim();
    if (!LAW_ARTICLE_PATTERN.test(jo)) {
      setArticleInputError(true);
      return;
    }
    setArticleInputError(false);
    void loadText(selected, jo);
  }

  if (selected) {
    const data = detail?.kind === "found" ? detail.data : overview;
    const promulgated = formatLawDate(data?.promulgationDate ?? selected.promulgationDate);
    const effective = formatLawDate(data?.effectiveDate ?? selected.effectiveDate);
    return <div className="law-search law-detail">
      <button type="button" className="law-search-link" onClick={backToResults}>← 검색 결과로</button>
      <section aria-labelledby="law-detail-heading" aria-busy={detailLoading}>
        <h2 id="law-detail-heading">{data?.name ?? selected.name}</h2>
        {(promulgated || effective) && <p className="law-search-meta">
          {promulgated && <span>공포일 {promulgated}</span>}
          {effective && <span>시행일 {effective}</span>}
        </p>}
        <form className="law-article-form" onSubmit={articleSearch}>
          <label htmlFor="law-article-number">조문 번호로 찾기</label>
          <div className="law-search-row">
            <input id="law-article-number" type="text" value={articleInput} placeholder="제74조 또는 제10조의2" onChange={(event) => {
              setArticleInput(event.target.value);
              setArticleInputError(false);
            }} />
            <button type="submit" className="law-search-button" disabled={detailLoading}>조문 보기</button>
          </div>
          {articleInputError && <p className="law-search-error" role="alert">조문 번호를 제74조 또는 제10조의2 형식으로 입력하세요.</p>}
        </form>
        {activeJo && overview && <button type="button" className="law-search-link law-detail-return" onClick={backToOverview}>
          {overview.mode === "toc" ? "← 목차로" : "← 법령 원문으로"}
        </button>}
        {detailLoading ? <p className="law-search-note" role="status">법령 원문을 불러오는 중…</p>
          : detail?.kind === "error" ? <div className="law-detail-feedback" role="alert">
            <p className="law-search-error">{detail.message}</p>
            <button type="button" className="law-search-link" onClick={() => void loadText(selected, activeJo)}>다시 시도</button>
          </div>
          : detail?.kind === "missing" ? <div className="law-detail-feedback" role="status">
            <p className="law-search-note">요청한 {activeJo ? "조문" : "법령 원문"}을 찾을 수 없습니다.</p>
          </div>
          : detail?.kind === "found" ? <div className="law-detail-content">
            <h3>{activeJo ?? (detail.data.mode === "toc" ? "목차" : "법령 원문")}</h3>
            {activeJo && <div className="law-related-actions">
              <button id="related-decisions" type="button" className="law-search-link" onClick={() => onRelated(selected, activeJo)}>관련 판례·결정례</button>
              <button id="law-applicable-action" type="button" className="law-search-link" onClick={() => onAnalysis({ mode: "applicable_law", lawName: detail.data.name ?? overview?.name ?? selected.name, jo: activeJo, origin: "law" }, "law-applicable-action")}>시점별 적용 법령</button>
              <button id="law-impact-action" type="button" className="law-search-link" onClick={() => onAnalysis({ mode: "impact_map", lawName: detail.data.name ?? overview?.name ?? selected.name, jo: activeJo, origin: "law" }, "law-impact-action")}>조문 영향도</button>
            </div>}
            {detail.data.mode !== "toc" || !detail.data.articles?.length ? <pre className="law-detail-raw">{detail.data.text}</pre> : null}
            {detail.data.mode === "toc" && detail.data.articles?.length ? <details className="law-detail-source">
              <summary>원문 보기</summary>
              <pre className="law-detail-raw">{detail.data.text}</pre>
            </details> : null}
            {detail.data.mode === "toc" && detail.data.articles && detail.data.articles.length > 0 && <nav aria-label="조문 목차">
              <ul className="law-article-list">{detail.data.articles.map((article, index) => <li key={`${article.jo}-${index}`}>
                <button type="button" onClick={() => {
                  setArticleInput(article.jo);
                  void loadText(selected, article.jo);
                }}>{article.jo} {article.title}</button>
              </li>)}</ul>
            </nav>}
          </div> : null}
      </section>
    </div>;
  }

  return <div className="law-search">
    <form className="law-search-form" role="search" onSubmit={(event) => void search(event)}>
      <div className="law-search-row">
        <input id="law-query" type="search" value={query} maxLength={200} placeholder="법령명 또는 키워드 검색" aria-label="법령명 또는 키워드 검색" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="law-search-button" disabled={searchLoading || !query.trim()}>{searchLoading ? "검색 중…" : "검색"}</button>
      </div>
    </form>

    <section className="law-search-results" aria-labelledby="law-results-heading" aria-busy={searchLoading}>
      <h2 id="law-results-heading">검색 결과{outcome?.kind === "found" ? ` · ${outcome.laws.length}건` : ""}</h2>
      {searchLoading ? <p className="law-search-note" role="status">검색 중…</p>
        : !outcome ? null
        : outcome.kind === "error" ? <p className="law-search-error" role="alert">{outcome.message}</p>
        : outcome.kind === "empty" ? <p className="law-search-note" role="status">검색 결과가 없습니다. 다른 법령명이나 키워드로 검색해보세요.</p>
        : <ul className="law-search-list">
          {outcome.laws.map((law, index) => {
            const effective = formatLawDate(law.effectiveDate);
            const promulgated = formatLawDate(law.promulgationDate);
            const tone = lawStatusTone(law.status);
            const content = <>
              <strong>{law.name}</strong>
              <span className="law-search-meta">
                {law.kind && <span>{law.kind}</span>}
                {law.status && <span className={`law-search-status is-${tone}`}>{law.status}</span>}
                {effective && <span>시행일 {effective}</span>}
                {promulgated && <span>공포일 {promulgated}</span>}
              </span>
            </>;
            return <li key={law.mst ?? law.lawId ?? `${law.name}-${index}`}>
              {lawTextIdentifier(law)
                ? <button type="button" className="law-search-result" onClick={() => openLaw(law)}>{content}</button>
                : <div className="law-search-unavailable">{content}<span className="law-search-note">원문 조회 불가</span></div>}
            </li>;
          })}
        </ul>}
    </section>
  </div>;
}
