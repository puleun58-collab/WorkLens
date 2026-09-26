/**
 * 15 live regression cases, each covering a different path. Expectations are
 * stable facts checked against 법제처 on 2026-09 (법령ID is stable across
 * amendments, unlike MST); update one only when the law itself changes.
 */
export type RegressionCase =
  | { kind: "law"; id: string; category: string; query: string;
    expect: { name: string; lawId: string; alsoListed?: string[]; article?: { jo: string; title?: string; structure?: string[] } } }
  | { kind: "research"; id: string; category: string; body: Record<string, unknown> & { task: string; query: string };
    expect: { kinds?: string[]; supplementArticle?: { law: string; jo: string }; precedentsRanked?: boolean } }
  | { kind: "decisions"; id: string; category: string; domain: string; query: string }
  | { kind: "empty"; id: string; category: string; query: string };

export const CASES: RegressionCase[] = [
  { kind: "law", id: "01", category: "일반 현행 법률 + 조문", query: "근로기준법",
    expect: { name: "근로기준법", lawId: "001872", article: { jo: "제23조", title: "해고 등의 제한" } } },
  { kind: "law", id: "02", category: "조·항·호 구조", query: "근로기준법",
    expect: { name: "근로기준법", lawId: "001872", article: { jo: "제2조", title: "정의", structure: ["①", "^\\s*1\\.\\s"] } } },
  { kind: "law", id: "03", category: "유사 명칭 후보 (민법 vs 난민법)", query: "민법",
    expect: { name: "민법", lawId: "001706", alsoListed: ["난민법"], article: { jo: "제750조", title: "불법행위의 내용" } } },
  { kind: "law", id: "04", category: "긴 정식 명칭", query: "전자상거래 등에서의 소비자보호에 관한 법률",
    expect: { name: "전자상거래 등에서의 소비자보호에 관한 법률", lawId: "009318", article: { jo: "제17조", title: "청약철회등" } } },
  { kind: "law", id: "05", category: "약칭 입력", query: "전자상거래법",
    expect: { name: "전자상거래 등에서의 소비자보호에 관한 법률", lawId: "009318" } },
  { kind: "law", id: "06", category: "띄어쓰기 차이", query: "개인정보보호법",
    expect: { name: "개인정보 보호법", lawId: "011357", article: { jo: "제17조", title: "개인정보의 제공" } } },
  { kind: "law", id: "07", category: "애매한 후보 (주택/상가 임대차)", query: "임대차보호법",
    expect: { name: "주택임대차보호법", lawId: "001248", alsoListed: ["상가건물 임대차보호법"], article: { jo: "제3조의2", title: "보증금의 회수" } } },
  { kind: "law", id: "08", category: "하위법령 섞인 결과 (법률 선택)", query: "건축법",
    expect: { name: "건축법", lawId: "001823", alsoListed: ["건축법 시행령"], article: { jo: "제80조", title: "이행강제금" } } },
  { kind: "law", id: "09", category: "개정 잦은 법률", query: "소득세법",
    expect: { name: "소득세법", lawId: "001565", article: { jo: "제1조", title: "목적" } } },
  { kind: "research", id: "10", category: "시점 비교 (time_travel)",
    body: { task: "amendment_track", query: "근로기준법", scenario: "time_travel", fromDate: "2022-01-01", toDate: "2026-01-01" }, expect: {} },
  { kind: "research", id: "11", category: "종합 리서치: 판례 relevance + 결과 없음 상태",
    body: { task: "full_research", query: "직장 내 괴롭힘 판단 기준" }, expect: { kinds: ["law_articles", "decision_search"], precedentsRanked: true } },
  { kind: "research", id: "12", category: "처분 근거: 조문 보정",
    body: { task: "action_basis", query: "건축법 이행강제금" }, expect: { supplementArticle: { law: "건축법", jo: "제80조" } } },
  { kind: "research", id: "13", category: "절차·서식: 별표/서식 파싱",
    body: { task: "procedure_detail", query: "행정심판 청구 절차와 제출서류" }, expect: { kinds: ["annex"] } },
  { kind: "decisions", id: "14", category: "판례 검색 목록", domain: "precedent", query: "부당해고" },
  { kind: "empty", id: "15", category: "정상적인 결과 없음", query: "존재하지않는가상법률명" },
];
