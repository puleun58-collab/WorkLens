import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface CompanyTermEntry { id: number; term: string; description: string | null; active: boolean }

/** Dictionary and Settings share one utility surface and preserve local preferences. */
export function SettingsView({ view, companyTerms, companyTermsSource, userTerms, ignoredRules, onAddTerm, onRemoveTerm, onClearTerms, onToggleRule }: {
  view: "Dictionary" | "Settings";
  companyTerms: CompanyTermEntry[];
  companyTermsSource: "d1" | "seed" | "pending";
  userTerms: string[];
  ignoredRules: string[];
  onAddTerm: (term: string) => void;
  onRemoveTerm: (term: string) => void;
  onClearTerms: () => void;
  onToggleRule: (ruleId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [expandCompany, setExpandCompany] = useState(false);
  const matchedCompanyTerms = companyTerms.filter((entry) =>
    !search.trim() || entry.term.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  if (view === "Settings") {
    return (
      <section className="settings-surface" aria-label="Settings">
        <dl className="settings-list">
          <div><dt>저장 위치</dt><dd>파일과 분석 결과는 이 탭의 메모리에만 있습니다. 새로고침하면 사라집니다.</dd></div>
          <div><dt>localStorage</dt><dd>개인 사전 단어, 무시한 규칙 ID와 검토 설정(문서 입력 방식·출처 표시 기본값)만 저장합니다. 문서 본문, 근거, 질문과 답변은 브라우저 저장소에 저장하지 않습니다.</dd></div>
          <div><dt>무시한 규칙</dt><dd>
            {ignoredRules.length
              ? <div className="dictionary-term-list">{ignoredRules.map((rule) => (
                <span className="dictionary-term" key={rule}>{rule}
                  <Button variant="outline" type="button" aria-label={`${rule} 복원`} onClick={() => onToggleRule(rule)}>×</Button>
                </span>
              ))}</div>
              : "없음"}
          </dd></div>
          <div><dt>서버 AI</dt><dd>AI 기능은 필요한 질문·문장·근거만 서버 AI로 전송해 처리합니다. 원본 파일은 전송하지 않습니다.</dd></div>
          <div><dt>법령 기능 외부 연동</dt><dd>법령 기능 사용 시 필요한 검색어·검증 문구가 Korean Law MCP로 전송될 수 있으며, 문서 검토는 원문이 아닌 관련 법령·판례 조회용 검색어만 전송됩니다.<br />입력 내용은 WorkLens에 저장되지 않습니다.</dd></div>
        </dl>
      </section>
    );
  }
  return (
    <section className="settings-surface" aria-label="Dictionary">
      <div className="dictionary-section">
        <h4>COMPANY TERMS <span>{companyTerms.length}</span></h4>
        <p className="dictionary-note">
          회사 공통 용어입니다. 관리자만 수정할 수 있습니다.
          {companyTermsSource === "seed" ? " 공용 사전 저장소에 연결하지 못해 기본 목록을 표시합니다." : null}
        </p>
        <form onSubmit={(event) => event.preventDefault()}>
          <Input value={search} placeholder="용어 검색" aria-label="공용 용어 검색" onChange={(event) => setSearch(event.target.value)} />
        </form>
        <div className={expandCompany || search.trim() ? "dictionary-term-list" : "dictionary-term-list collapsed"}>
          {matchedCompanyTerms.map((entry) => (
            <span className="dictionary-term quiet" key={entry.id} title={entry.description ?? undefined}>{entry.term}</span>
          ))}
          {matchedCompanyTerms.length === 0 ? <span className="dictionary-empty">일치하는 공용 용어가 없습니다.</span> : null}
        </div>
        {!search.trim() && companyTerms.length > 0 ? (
          <Button variant="outline" type="button" className="dictionary-more" onClick={() => setExpandCompany((open) => !open)}>
            {expandCompany ? "접기" : `전체 보기 (${companyTerms.length}개)`}
          </Button>
        ) : null}
      </div>
      <div className="dictionary-section">
        <h4>MY TERMS <span>{userTerms.length}</span></h4>
        <form onSubmit={(event) => { event.preventDefault(); onAddTerm(draft); setDraft(""); }}>
          <Input value={draft} maxLength={64} placeholder="용어 추가" aria-label="개인 용어 추가" onChange={(event) => setDraft(event.target.value)} />
          <Button variant="outline" type="submit" disabled={!draft.trim()}>추가</Button>
        </form>
        {userTerms.length
          ? <div className="dictionary-term-list">{userTerms.map((term) => (
            <span className="dictionary-term" key={term}>{term}
              <Button variant="outline" type="button" aria-label={`${term} 삭제`} onClick={() => onRemoveTerm(term)}>×</Button>
            </span>
          ))}</div>
          : <p className="dictionary-empty">등록된 개인 용어가 없습니다.</p>}
        {userTerms.length ? (
          <div className="dictionary-actions">
            <Button variant="outline" type="button" className="dictionary-reset" onClick={onClearTerms}>전체 초기화</Button>
          </div>
        ) : null}
        <p className="dictionary-note">개인 사전은 이 브라우저에만 저장됩니다.</p>
      </div>
    </section>
  );
}
