/**
* 법률 정확도 평가셋 v1 (결정론적, CI 실행 가능).
*
* 실제 운영 MCP를 호출하지 않고, 실제 프로덕션 함수
* (questionTerms / rankPrecedent / researchEvidenceSources / lawCitationTarget /
* citedHo / versionMatchesVerification)에 fixture를 넣어 기대 결과를 검증한다.
*
* 각 사례의 정답은 아래 `source`·`verifiedOn`에 기록된 공식 자료 확인을 기반으로 하며,
* `reviewStatus: "unverified"`인 사례는 확정 정답이 아니라 경계 케이스로만 사용된다.
* 개인정보·실제 사용자 문서·비공개 상담 내용은 포함하지 않는다.
*/

export type AccuracyCaseKind = "relevance" | "citation" | "evidence" | "version" | "status";

export interface AccuracyCase {
id: string;
category: string;
kind: AccuracyCaseKind;
question: string;
/** 기준 날짜 (YYYYMMDD). 버전·시행일 판정에 사용. */
referenceDate: string;
/** 검증된 공식 자료 출처. */
source: string;
verifiedOn: string;
reviewStatus: "verified" | "unverified";
/** 반드시 배제해야 할 무관한 근거 (오판 탐지용). */
excludeIrrelevant?: string[];
input: unknown;
expected: unknown;
}

/** 판례 fixture: rankPrecedent에 그대로 전달된다. */
interface PrecedentFixture {
title?: string;
summary?: string;
excerpt?: boolean;
citedArticles?: string[];
}

const VERIFIED = "2026-10-17" as const;

export const CASES: AccuracyCase[] = [
// ── 1. 명확한 법령·조문 검색 ──────────────────────────────────────────
{
id: "A01", category: "명확한 법령·조문 검색", kind: "citation",
question: "근로기준법상 해고 제한 규정은?",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제23조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { citation: "근로기준법 제23조(해고 등의 제한)"},
expected: { lawName: "근로기준법", jo: "제23조", title: "해고 등의 제한"},
},
{
id: "A02", category: "명확한 법령·조문 검색", kind: "citation",
question: "근로기준법 연차유급휴가 제6항의 내용은?",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제60조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { citation: "근로기준법 제60조(연차 유급휴가) 제6항"},
expected: { lawName: "근로기준법", jo: "제60조", title: "연차 유급휴가", hang: 6},
},
{
id: "A03", category: "명확한 법령·조문 검색", kind: "relevance",
question: "직장 내 괴롭힘 판단 기준",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제76조의2", verifiedOn: VERIFIED, reviewStatus: "verified",
excludeIrrelevant: ["부당이득반환청구권의 소멸시효"],
input: {
precedents: [
{ id: "p1", title: "손해배상(기)", summary: "직장 내 괴롭힘으로 인한 사용자의 손해배상책임이 인정되는 요건"},
{ id: "p2", title: "부당이득금반환", summary: "부당이득반환청구권의 소멸시효 기산점"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct", p2: "low"},
},

// ── 2. 복수 조문 ─────────────────────────────────────────────────────
{
id: "A04", category: "복수 조문", kind: "evidence",
question: "해고와 퇴직금 관련 규정",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제23조·제34조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
// 실제 운영처럼 쟁점별로 분리 평가 (issueSources는 issueQuery 단위로 호출됨)
issues: ["해고 규정", "퇴직금 규정"],
text: [
"═══ 종합 리서치: 해고와 퇴직금 관련 규정 ═══", "",
"▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 2건):", "",
"근로기준법", " 제23조 (해고 등의 제한)", " 제23조(해고 등의 제한)", " 사용자는 근로자에게 정당한 이유 없이 해고하지 못한다.",
" 시행: 2026.01.01 | 고용노동부", "",
"근로기준법", " 제34조 (퇴직급여 제도)", " 제34조(퇴직급여 제도)", " 사용자는 퇴직하는 근로자에게 퇴직금을 지급하여야 한다.",
" 시행: 2026.01.01 | 고용노동부", "",
].join("\n"),
},
expected: { articles: [{ law: "근로기준법", jo: "제23조"}, { law: "근로기준법", jo: "제34조"}]},
},
{
id: "A05", category: "복수 조문", kind: "citation",
question: "민법 제750조 제1항의 불법행위 요건은?",
referenceDate: "20261017",
source: "국가법령정보센터 민법 제750조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
inputText: "민법 제750조 제1항에 따라 손해배상을 청구한다. 또한 민법 제750조 제2항도 검토한다.",
citations: ["민법 제750조(불법행위의 내용) 제1항", "민법 제750조(불법행위의 내용) 제2항"],
expectedHo: [undefined, undefined],
},
expected: [
{ lawName: "민법", jo: "제750조", title: "불법행위의 내용", hang: 1},
{ lawName: "민법", jo: "제750조", title: "불법행위의 내용", hang: 2},
],
},

// ── 3. 판례·결정례 검색 ──────────────────────────────────────────────
{
id: "A06", category: "판례·결정례 검색", kind: "relevance",
question: "부당해고 구제 신청 관련 판례",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "해고무효확인", summary: "부당해고 구제신청에 대한 노동위원회의 재심판정 취소 요건"},
{ id: "p2", title: "징계처분취소", summary: "근로기준법 제76조의2에서 정한 직장 내 괴롭힘 행위에 해당하는지 판단하는 방법"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct", p2: "low"},
},
{
id: "A07", category: "판례·결정례 검색", kind: "relevance",
question: "임금 체불 시 지연이자",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "임금", summary: "임금 체불 시 지연이자의 기산점과 이율", excerpt: true},
] as Array<PrecedentFixture & { id: string}>,
},
// excerpt는 최대 related까지만 가능
expected: { p1: "related"},
},
{
id: "A08", category: "판례·결정례 검색", kind: "relevance",
question: "영업비밀 침해 금지청구",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
// 판시사항을 읽지 못한 경우 unknown — 추측하지 않음
{ id: "p1", title: "영업비밀침해금지"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "unknown"},
},

// ── 4. 관련성 부족 판례 ──────────────────────────────────────────────
{
id: "A09", category: "관련성 부족 판례", kind: "relevance",
question: "직장 내 괴롭힘 판단 기준",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
excludeIrrelevant: ["이사장 직무집행 방해"],
input: {
precedents: [
// 제목에 질문어가 있어도 판시사항이 무관하면 low
{ id: "p1", title: "직장 내 괴롭힘 손해배상", summary: "부당이득반환청구권의 소멸시효"},
{ id: "p2", title: "방해금지청구", summary: " 이사장 직무집행 방해 금지를 구한다.", excerpt: true},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "low", p2: "low"},
},
{
id: "A10", category: "관련성 부족 판례", kind: "relevance",
question: "건축법 이행강제금 부과 근거",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
excludeIrrelevant: ["과태료와 이행강제금의 구별이 쟁점이 아닌 사건"],
input: {
precedents: [
{ id: "p1", title: "이행강제금부과처분취소", summary: "주차장법 위반에 대한 과태료 부과처분의 적법 여부"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "low"},
},
{
id: "A11", category: "관련성 부족 판례", kind: "evidence",
question: "개인정보 유출 시 손해배상",
referenceDate: "20261017",
source: "국가법령정보센터 개인정보 보호법", verifiedOn: VERIFIED, reviewStatus: "verified",
excludeIrrelevant: ["개인정보의 제공 (제3자 제공 일반 규정)"],
input: {
// 제17조(개인정보의 제공)는 질문어 '개인정보'를 포함하지만 쟁점(유출·손해배상)을 다루지 않음
text: [
"═══ 종합 리서치: 개인정보 유출 시 손해배상 ═══", "",
"▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
"개인정보 보호법", " 제17조 (개인정보의 제공)", " 제17조(개인정보의 제공)", " 개인정보처리자는 정보주체의 동의를 받아 개인정보를 제3자에게 제공할 수 있다.",
" 시행: 2026.01.01 | 개인정보보호위원회", "",
].join("\n"),
},
expected: { articles: []},
},

// ── 5. 부정 표현 및 예외 규정 ─────────────────────────────────────────
{
id: "A12", category: "부정 표현·예외 규정", kind: "relevance",
question: "해고가 금지되는 경우",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제23조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "해고무효확인", summary: "정당한 이유 없는 해고는 무효이며 해고가 금지되는 사유에 해당한다"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct"},
},
{
id: "A13", category: "부정 표현·예외 규정", kind: "citation",
question: "근로기준법 제23조 제1항 단서의 예외는?",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법 제23조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { citation: "근로기준법 제23조(해고 등의 제한) 제1항"},
expected: { lawName: "근로기준법", jo: "제23조", title: "해고 등의 제한", hang: 1},
},

// ── 6. 상반된 판례 ───────────────────────────────────────────────────
{
id: "A14", category: "상반된 판례", kind: "relevance",
question: "정리해고의 정당성 요건",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "unverified",
input: {
precedents: [
{ id: "p1", title: "해고무효확인", summary: "정리해고의 정당성 요건으로서 긴박한 경영상 필요성이 인정되어 해고가 정당하다"},
{ id: "p2", title: "해고무효확인", summary: "정리해고의 정당성 요건 중 긴박한 경영상 필요성이 인정되지 않아 해고가 부당하다"},
] as Array<PrecedentFixture & { id: string}>,
},
// 결론이 달라도 쟁점(정리해고 정당성 요건)을 다루면 관련성은 인정됨
expected: { p1: "direct", p2: "direct"},
},
{
id: "A15", category: "상반된 판례", kind: "relevance",
question: "직장 내 괴롭힘 판단 기준",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "손해배상(기)", summary: "직장 내 괴롭힘에 해당하여 손해배상책임이 인정된다"},
{ id: "p2", title: "손해배상(기)", summary: "직장 내 괴롭힘에 해당하지 않아 손해배상책임이 인정되지 않는다"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct", p2: "direct"},
},

// ── 7. 개정 전후 비교 ────────────────────────────────────────────────
{
id: "A16", category: "개정 전후 비교", kind: "version",
question: "2022년 당시 근로기준법상 주52시간 규정",
referenceDate: "20220101",
source: "국가법령정보센터 근로기준법 연혁", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { effectiveDate: "20210706", verifiedOn: "20220101"},
expected: { matches: true},
},
{
id: "A17", category: "개정 전후 비교", kind: "version",
question: "2022년 당시 기준으로 2024년 시행 조문 인용 시",
referenceDate: "20220101",
source: "국가법령정보센터 법령 연혁", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { effectiveDate: "20240101", verifiedOn: "20220101"},
// 기준일 이후 시행 버전은 검증 당시 확인한 버전이 아님
expected: { matches: false},
},

// ── 8. 시행일 차이 ───────────────────────────────────────────────────
{
id: "A18", category: "시행일 차이", kind: "version",
question: "현재 시행 중인 중대재해처벌법 조문",
referenceDate: "20261017",
source: "국가법령정보센터 중대재해처벌법", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { effectiveDate: "20220127", verifiedOn: "20261017"},
expected: { matches: true},
},
{
id: "A19", category: "시행일 차이", kind: "version",
question: "시행일 형식이 비정상인 경우 관대하게 처리",
referenceDate: "20261017",
source: "내부 규칙 (citation-evidence.versionMatchesVerification)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { effectiveDate: "시행일 미상", verifiedOn: "20261017"},
expected: { matches: true},
},

// ── 9. 조례 vs 상위법 ────────────────────────────────────────────────
{
id: "A20", category: "조례 vs 상위법", kind: "relevance",
question: "서울시 주차장 설치 조례의 위임 근거",
referenceDate: "20261017",
source: "국가법령정보센터 주차장법·서울특별시 주차장 설치 및 관리 조례", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "조례무효확인", summary: "서울시 주차장 설치 조례가 주차장법의 위임 범위를 벗어났는지 판단"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct"},
},

// ── 10. 절차·의무·기한 ───────────────────────────────────────────────
{
id: "A21", category: "절차·의무·기한", kind: "evidence",
question: "행정심판 청구 절차와 제출서류",
referenceDate: "20261017",
source: "국가법령정보센터 행정심판법", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
issues: ["행정심판 청구"],
text: [
"═══ 종합 리서치: 행정심판 청구 절차와 제출서류 ═══", "",
"▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
"행정심판법", " 제27조 (심판청구의 제기)", " 제27조(심판청구의 제기)", " 행정심판 청구는 처분이 있음을 안 날부터 90일 이내에 제기하여야 한다.",
" 시행: 2026.01.01 | 법제처", "",
].join("\n"),
},
expected: { articles: [{ law: "행정심판법", jo: "제27조"}]},
},
{
id: "A22", category: "절차·의무·기한", kind: "citation",
question: "행정심판법 제27조 제1항의 청구 기한은?",
referenceDate: "20261017",
source: "국가법령정보센터 행정심판법 제27조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { citation: "행정심판법 제27조(심판청구의 제기) 제1항"},
expected: { lawName: "행정심판법", jo: "제27조", title: "심판청구의 제기", hang: 1},
},

// ── 11. 복수 쟁점 종합 ───────────────────────────────────────────────
{
id: "A23", category: "복수 쟁점 종합", kind: "evidence",
question: "부당해고 구제와 밀린 임금 청구",
referenceDate: "20261017",
source: "국가법령정보센터 근로기준법", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
issues: ["부당해고 구제", "밀린 임금"],
text: [
"═══ 종합 리서치: 부당해고 구제와 밀린 임금 청구 ═══", "",
"▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 2건):", "",
"근로기준법", " 제28조 (부당해고등의 구제신청)", " 제28조(부당해고등의 구제신청)", " 부당해고를 당한 근로자는 노동위원회에 부당해고 구제를 신청할 수 있다.",
" 시행: 2026.01.01 | 고용노동부", "",
"근로기준법", " 제43조 (임금 지급)", " 제43조(임금 지급)", " 밀린 임금은 매월 1회 이상 일정한 날짜를 정하여 지급하여야 한다.",
" 시행: 2026.01.01 | 고용노동부", "",
].join("\n"),
},
expected: { articles: [{ law: "근로기준법", jo: "제28조"}, { law: "근로기준법", jo: "제43조"}]},
},
{
id: "A24", category: "복수 쟁점 종합", kind: "relevance",
question: "부당해고 구제와 밀린 임금 청구",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
// 운영은 쟁점별로 분리해 평가하므로 케이스도 쟁점 단위로 기술
issues: [
{ query: "부당해고 구제", expect: { p1: "direct"} },
{ query: "밀린 임금 청구", expect: { p2: "direct"} },
],
precedents: [
{ id: "p1", title: "해고무효확인", summary: "부당해고 구제신청에 대한 노동위원회의 구제명령과 구제이익"},
{ id: "p2", title: "임금", summary: "밀린 임금 청구에 대한 체불임금의 지연손해금 지급 의무"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct", p2: "direct"},
},

// ── 12. 근거 불충분 질문 ─────────────────────────────────────────────
{
id: "A25", category: "근거 불충분 질문", kind: "evidence",
question: "존재하지않는가상법률명에 따른 손해배상",
referenceDate: "20261017",
source: "내부 규칙 (PR #204: 정상 빈 결과는 부분 실패가 아님)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
text: [
"═══ 종합 리서치: 존재하지않는가상법률명에 따른 손해배상 ═══", "",
"▶ AI 법령검색 결과", "[NOT_FOUND] 검색 결과가 없습니다.", "",
].join("\n"),
},
// 근거가 없으면 채택도 없음 — 확정 판단 금지
expected: { articles: []},
},
{
id: "A26", category: "근거 불충분 질문", kind: "relevance",
question: "달나라 토지 소유권 이전 등기",
referenceDate: "20261017",
source: "내부 규칙 (근거 부족 시 확정 판단 금지)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "소유권이전등기", summary: "부동산 소유권이전등기청구권의 소멸시효"},
] as Array<PrecedentFixture & { id: string}>,
},
// 용어 기반 매칭의 한계: '달나라'라는 터무니없는 전제를 걸러내지 못하고 related가 됨.
// 안전장치는 direct로 승격되지 않는 것. 전문가 검토 필요 항목으로 기록.
expected: { p1: "related"},
},

// ── 13. 동어이의 자료 ────────────────────────────────────────────────
{
id: "A27", category: "동어이의 자료", kind: "relevance",
question: "민법 불법행위 손해배상",
referenceDate: "20261017",
source: "대법원 판례 (판시사항 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
excludeIrrelevant: ["형사 불법행위(범죄) 관련 판례"],
input: {
precedents: [
{ id: "p1", title: "손해배상(기)", summary: "민법 제750조 불법행위로 인한 손해배상책임의 성립 요건"},
{ id: "p2", title: "손해배상(기)", summary: "불법행위 범죄에 대한 형사처벌의 양형 기준"},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "direct", p2: "low"},
},
{
id: "A28", category: "동어이의 자료", kind: "citation",
question: "「민법」 제750조와 「형법」상 과실치상죄의 차이는?",
referenceDate: "20261017",
source: "국가법령정보센터 민법 제750조", verifiedOn: VERIFIED, reviewStatus: "verified",
input: { citation: "민법 제750조(불법행위의 내용)"},
expected: { lawName: "민법", jo: "제750조", title: "불법행위의 내용"},
},

// ── 14. 문서 검토 연결 ───────────────────────────────────────────────
{
id: "A29", category: "문서 검토 연결", kind: "citation",
question: "계약서 제2조(해지) 검토 — 을의 해지권 박탈 조항",
referenceDate: "20261017",
source: "내부 규칙 (citation-evidence.citedHo: 조·항별 호 복원)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
inputText: "약관의 규제에 관한 법률 제7조 제2호에 해당하는 불공정 조항이다.",
citations: ["약관의 규제에 관한 법률 제7조(면책조항 등의 금지) 제2호"],
expectedHo: [2],
},
expected: [{ lawName: "약관의 규제에 관한 법률", jo: "제7조", title: "면책조항 등의 금지"}],
},

// ── 15. 원문 미확인 ──────────────────────────────────────────────────
{
id: "A30", category: "원문 미확인", kind: "relevance",
question: "하급심 판례의 판시사항 미제공 사례",
referenceDate: "20261017",
source: "내부 규칙 (판시사항 없으면 unknown 유지, 추측 금지)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
precedents: [
{ id: "p1", title: "손해배상(기)", summary: undefined},
] as Array<PrecedentFixture & { id: string}>,
},
expected: { p1: "unknown"},
},

// ── 16. 상태 판정 (PR #204 회귀) ─────────────────────────────────────
{
id: "A31", category: "상태 판정", kind: "status",
question: "섹션 상태 계산: 정상 빈 결과는 부분 실패가 아님",
referenceDate: "20261017",
source: "내부 규칙 (PR #204: section.unavailable 기준)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
// researchResult가 파싱하는 실제 섹션 형식
text: [
"═══ 종합 리서치: 상태 판정 ═══", "",
"▶ AI 법령검색 결과", "지능형 법령검색 결과 (법령조문, 1건):", "",
"근로기준법", "   제23조 (해고 등의 제한)", "   제23조(해고 등의 제한)", " 사용자는 근로자에게 정당한 이유 없이 해고하지 못한다.", "",
"▶ 법령 해석례 [NOT_FOUND / FAILED]", "   사유: [NOT_FOUND] 해석례 검색 결과가 없습니다.", "",
"▶ 관련 판례 [FAILED]", "   사유: [EXTERNAL_API_ERROR] 판례 조회에 실패했습니다.", "",
].join("\n"),
},
// not_found는 정상 빈 결과 → unavailable 카운트에서 제외, failed만 카운트
expected: { unavailableCount: 1, statuses: ["available", "not_found", "failed"]},
},
{
id: "A32", category: "상태 판정", kind: "status",
question: "모든 섹션 정상 빈 결과",
referenceDate: "20261017",
source: "내부 규칙 (PR #204)", verifiedOn: VERIFIED, reviewStatus: "verified",
input: {
text: [
"═══ 종합 리서치: 빈 결과 ═══", "",
"▶ AI 법령검색 결과 [NOT_FOUND / FAILED]", "   사유: [NOT_FOUND] 검색 결과가 없습니다.", "",
"▶ 관련 판례 [NOT_FOUND / FAILED]", "   사유: [NOT_FOUND] 검색 결과가 없습니다.", "",
].join("\n"),
},
expected: { unavailableCount: 0, statuses: ["not_found", "not_found"]},
},
];

export const ACCURACY_SET_VERSION = "1.0.0";
