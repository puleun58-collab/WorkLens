"use client";

import { useRef, useState, type FormEvent } from "react";
import { formatLawDate, LAW_FALLBACK_ERROR, lawOutcome, lawStatusTone, type LawOutcome } from "@/lib/law-search";
import "./law-search.css";

export function LawSearch() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LawOutcome | null>(null);
  const inFlight = useRef(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await fetch("/api/law", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      setOutcome(lawOutcome(response.ok, await response.json().catch(() => null)));
    } catch {
      setOutcome({ kind: "error", message: LAW_FALLBACK_ERROR });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return <div className="law-search">
    <form className="law-search-form" role="search" onSubmit={(event) => void search(event)}>
      <label htmlFor="law-query">법령명 또는 키워드로 현행 법령을 검색하세요.</label>
      <div className="law-search-row">
        <input id="law-query" type="search" value={query} maxLength={200} placeholder="법령명 또는 키워드 검색" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="law-search-button" disabled={loading || !query.trim()}>{loading ? "검색 중…" : "검색"}</button>
      </div>
    </form>

    <section className="law-search-results" aria-labelledby="law-results-heading" aria-busy={loading}>
      <h2 id="law-results-heading">검색 결과{outcome?.kind === "found" ? ` · ${outcome.laws.length}건` : ""}</h2>
      {loading ? <p className="law-search-note" role="status">검색 중…</p>
        : !outcome ? <p className="law-search-note">법령명 또는 키워드를 입력해 검색하세요.</p>
        : outcome.kind === "error" ? <p className="law-search-error" role="alert">{outcome.message}</p>
        : outcome.kind === "empty" ? <p className="law-search-note" role="status">검색 결과가 없습니다. 다른 법령명이나 키워드로 검색해보세요.</p>
        : <ul className="law-search-list">
          {outcome.laws.map((law, index) => {
            const effective = formatLawDate(law.effectiveDate);
            const promulgated = formatLawDate(law.promulgationDate);
            const tone = lawStatusTone(law.status);
            return <li key={law.mst ?? law.lawId ?? `${law.name}-${index}`}>
              <strong>{law.name}</strong>
              <span className="law-search-meta">
                {law.kind && <span>{law.kind}</span>}
                {law.status && <span className={`law-search-status is-${tone}`}>{law.status}</span>}
                {effective && <span>시행일 {effective}</span>}
                {promulgated && <span>공포일 {promulgated}</span>}
              </span>
            </li>;
          })}
        </ul>}
    </section>
  </div>;
}
