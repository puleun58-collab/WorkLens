"use client";

import { useCallback, useEffect, useState } from "react";
import { LogOut, Plus } from "lucide-react";
import { WorkLensLogo } from "../worklens-logo";

interface CompanyTerm {
  id: number;
  term: string;
  description: string | null;
  active: boolean;
  updatedAt: string | null;
}

type Feedback = { tone: "error" | "success"; message: string } | null;

function messageOf(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = payload.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState<CompanyTerm[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState({ term: "", description: "" });
  const [editing, setEditing] = useState<{ id: number; term: string; description: string } | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  const loadTerms = useCallback(async () => {
    const response = await fetch("/api/admin/company-terms", { cache: "no-store" });
    if (response.status === 401) {
      setAuthenticated(false);
      return;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setFeedback({ tone: "error", message: messageOf(payload, "공용 용어를 불러오지 못했습니다.") });
      return;
    }
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null;
    if (data && typeof data === "object" && "terms" in data && Array.isArray(data.terms)) {
      setTerms(data.terms as CompanyTerm[]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/admin/session", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null;
      const isAuthenticated = Boolean(data && typeof data === "object" && "authenticated" in data && data.authenticated);
      setAuthenticated(isAuthenticated);
      if (isAuthenticated) await loadTerms();
    })();
  }, [loadTerms]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFeedback({ tone: "error", message: messageOf(payload, "로그인에 실패했습니다.") });
        return;
      }
      setPassword("");
      setAuthenticated(true);
      await loadTerms();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    setTerms([]);
  };

  const mutate = async (input: RequestInfo, init: RequestInit, success: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(input, { ...init, headers: { "content-type": "application/json", ...init.headers } });
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        setAuthenticated(false);
        return false;
      }
      if (!response.ok) {
        setFeedback({ tone: "error", message: messageOf(payload, "요청을 처리하지 못했습니다.") });
        return false;
      }
      await loadTerms();
      setFeedback({ tone: "success", message: success });
      return true;
    } finally {
      setBusy(false);
    }
  };

  if (authenticated === null) {
    return <main className="admin-shell"><p className="admin-loading">세션을 확인하는 중입니다.</p></main>;
  }

  if (!authenticated) {
    return (
      <main className="admin-shell admin-login">
        <form onSubmit={login} aria-label="관리자 로그인">
          {/* Same call as the workspace rail brand, so both surfaces read as one product. */}
          <WorkLensLogo size={40} />
          <h1>WorkLens Admin</h1>
          <p>공용 용어 사전을 관리하려면 관리자 비밀번호가 필요합니다.</p>
          <label>
            <span>관리자 비밀번호</span>
            <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
          </label>
          {feedback ? <p className={`admin-feedback ${feedback.tone}`} role="alert">{feedback.message}</p> : null}
          <button type="submit" disabled={busy || !password}>로그인</button>
        </form>
      </main>
    );
  }

  const filtered = terms.filter((term) =>
    !query.trim()
    || term.term.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    || (term.description ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return (
    <main className="admin-shell">
      <header className="admin-bar">
        <WorkLensLogo size={24} tone="dark" />
        <span className="admin-title">Admin · Company Terms</span>
        <button type="button" className="secondary-action" onClick={logout}>
          <LogOut size={14} strokeWidth={1.75} aria-hidden="true" /> Logout
        </button>
      </header>

      <section className="admin-surface">
        <div className="admin-toolbar">
          <input
            type="search"
            value={query}
            placeholder="용어 검색"
            aria-label="용어 검색"
            onChange={(event) => setQuery(event.target.value)}
          />
          <form
            className="admin-add"
            onSubmit={async (event) => {
              event.preventDefault();
              const created = await mutate("/api/admin/company-terms", {
                method: "POST",
                body: JSON.stringify({ term: draft.term, description: draft.description || null }),
              }, `"${draft.term}"을(를) 추가했습니다.`);
              if (created) setDraft({ term: "", description: "" });
            }}
          >
            <input value={draft.term} maxLength={64} placeholder="용어" aria-label="새 용어" onChange={(event) => setDraft((current) => ({ ...current, term: event.target.value }))} />
            <input value={draft.description} maxLength={120} placeholder="설명" aria-label="새 용어 설명" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
            <button type="submit" disabled={busy || !draft.term.trim()}>
              <Plus size={14} strokeWidth={2} aria-hidden="true" /> 용어 추가
            </button>
          </form>
        </div>

        {feedback ? <p className={`admin-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p> : null}

        <div className="admin-table" role="table" aria-label="Company Terms">
          <div className="admin-table-head" role="row">
            <span role="columnheader">Term</span>
            <span role="columnheader">Description</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Action</span>
          </div>
          {filtered.length === 0 ? <p className="admin-empty">표시할 공용 용어가 없습니다.</p> : null}
          {filtered.map((term) => {
            const isEditing = editing?.id === term.id;
            return (
              <div className="admin-row" role="row" key={term.id}>
                {isEditing ? (
                  <>
                    <input value={editing.term} aria-label={`${term.term} 이름`} onChange={(event) => setEditing({ ...editing, term: event.target.value })} />
                    <input value={editing.description} aria-label={`${term.term} 설명`} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
                    <span className={term.active ? "admin-state active" : "admin-state"}>{term.active ? "Active" : "Inactive"}</span>
                    <span className="admin-actions">
                      <button
                        type="button"
                        onClick={async () => {
                          const saved = await mutate(`/api/admin/company-terms/${term.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({ term: editing.term, description: editing.description || null }),
                          }, "용어를 수정했습니다.");
                          if (saved) setEditing(null);
                        }}
                        disabled={busy}
                      >저장</button>
                      <button type="button" onClick={() => setEditing(null)}>취소</button>
                    </span>
                  </>
                ) : (
                  <>
                    <span role="cell" className="admin-term">{term.term}</span>
                    <span role="cell" className="admin-description">{term.description || "없음"}</span>
                    <span role="cell" className={term.active ? "admin-state active" : "admin-state"}>{term.active ? "Active" : "Inactive"}</span>
                    <span role="cell" className="admin-actions">
                      <button type="button" onClick={() => setEditing({ id: term.id, term: term.term, description: term.description ?? "" })}>Edit</button>
                      <button
                        type="button"
                        onClick={() => void mutate(`/api/admin/company-terms/${term.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ active: !term.active }),
                        }, term.active ? "용어를 비활성화했습니다." : "용어를 활성화했습니다.")}
                        disabled={busy}
                      >{term.active ? "Inactive" : "Active"}</button>
                      <button
                        type="button"
                        className="admin-danger"
                        onClick={() => {
                          if (!window.confirm(`${term.term} 공용 용어를 삭제하시겠습니까?`)) return;
                          void mutate(`/api/admin/company-terms/${term.id}`, { method: "DELETE" }, "용어를 삭제했습니다.");
                        }}
                        disabled={busy}
                      >Delete</button>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="admin-note">공용 용어는 설정 데이터입니다. 업무 문서와 분석 결과는 저장되지 않습니다.</p>
      </section>
    </main>
  );
}
