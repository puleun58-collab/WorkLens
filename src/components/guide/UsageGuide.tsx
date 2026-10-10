"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, FileSpreadsheet, FileText, Image as ImageIcon } from "lucide-react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import "./usage-guide.css";

/*
 * In-product usage guide: each feature is 3–4 miniature WorkLens screens.
 * Minis are built from the real UI vocabulary (file rows, segmented modes,
 * the 실행 button, result headers) so users can match them to the screen.
 * They are inert previews (aria-hidden, no pointer events); every step's
 * meaning is carried by its visible title and one-line description.
 */

type Step = { title: string; text: string; mini: ReactNode };
type Guide = { id: string; label: string; summary: string; steps: Step[]; tip?: string };

/** One mini file row; `mark` highlights the row the user acts on. */
function Row({ name, checked = false, role, mark = false, pdf = false }: { name: string; checked?: boolean; role?: string; mark?: boolean; pdf?: boolean }) {
  const Icon = pdf ? FileText : FileSpreadsheet;
  return (
    <span className={`mini-row${checked ? " is-checked" : ""}${mark ? " is-mark" : ""}`}>
      <i className="mini-check" />
      <Icon className="mini-file-icon" />
      <span className="mini-name">{name}</span>
      {role ? <b className="mini-role">{role}</b> : null}
    </span>
  );
}

const Upload = ({ label = "파일 추가", hint = "XLSX, CSV, PDF, DOCX, PPTX" }: { label?: string; hint?: string }) => (
  <span className="mini-drop"><strong>{label === "파일 추가" ? "파일 업로드" : label}</strong><small>{hint}</small><span className="mini-button is-mark">{label}</span></span>
);

const Run = ({ label = "실행", before = <Field text="선택한 파일로 실행" mark={false} /> }: { label?: string; before?: ReactNode }) => (
  <span className="mini-operation">{before}<span className="mini-button is-mark">{label}</span></span>
);

const Segments = ({ items, active }: { items: string[]; active: number }) => (
  <span className="mini-segments">{items.map((item, index) => <span key={item} className={index === active ? "is-active is-mark" : undefined}>{item}</span>)}</span>
);

const Field = ({ text, mark = true }: { text: string; mark?: boolean }) => <span className={`mini-field${mark ? " is-mark" : ""}`}>{text}</span>;

function Result({ title, status, lines, actions }: { title?: string; status: string; lines: string[]; actions?: string[] }) {
  return (
    <span className="mini-result">
      <span className="mini-result-head">{title ? <strong>{title}</strong> : null}<em>{status}</em></span>
      {lines.map((line) => <span className="mini-line" key={line}>{line}</span>)}
      {actions ? <span className="mini-actions">{actions.map((action, index) => <span key={action} className={index === actions.length - 1 ? "mini-button is-mark" : "mini-button is-quiet"}>{action}</span>)}</span> : null}
    </span>
  );
}

const Files = ({ children }: { children: ReactNode }) => <span className="mini-files">{children}</span>;

const selectFiles = (text = "작업할 파일 선택", names = ["운임현황_v1.xlsx", "운임현황_v2.xlsx"]): Step => ({
  title: "파일 선택",
  text,
  mini: <Files>{names.map((name) => <Row key={name} name={name} checked mark />)}</Files>,
});
const upload: Step = { title: "파일 업로드", text: "파일을 끌어 놓거나 ‘파일 추가’ 선택", mini: <Upload /> };

const GUIDES: Guide[] = [
  {
    id: "analyze", label: "분석", summary: "선택한 파일의 핵심 요약과 확인된 항목·수치",
    steps: [
      upload,
      selectFiles("분석할 파일 선택", ["회의자료.pptx"]),
      { title: "실행", text: "분석 탭에서 실행", mini: <Run /> },
      { title: "결과 확인", text: "요약·수치와 근거 위치 확인", mini: <Result status="분석 완료" lines={["핵심 요약", "확인된 수치 · 근거 Slide 3"]} /> },
    ],
    tip: "작업 파일은 브라우저 탭 메모리에만 저장되며, 새로고침하면 사라집니다",
  },
  {
    id: "ask", label: "질문", summary: "선택한 파일을 근거로 질문에 답변",
    steps: [
      selectFiles("근거로 삼을 파일 선택", ["계약.docx"]),
      { title: "질문 입력", text: "확인할 내용 입력", mini: <Field text="계약 기간은 언제까지인가요?" /> },
      { title: "실행", text: "실행 선택", mini: <Run before={<Field text="질문 입력됨" mark={false} />} /> },
      { title: "답변 확인", text: "답변과 근거 위치 확인", mini: <Result status="답변 완료" lines={["계약 기간 · 근거 2페이지"]} /> },
    ],
  },
  {
    id: "compare", label: "비교", summary: "두 파일의 변경 사항 또는 여러 파일의 값 차이",
    steps: [
      selectFiles("비교할 두 파일 선택"),
      {
        title: "기준/대상 확인", text: "필요하면 ‘기준/대상 바꾸기’ 선택",
        mini: <span className="mini-map"><span><small>기준 파일</small>v1.xlsx</span><ArrowRight className="mini-arrow-icon" /><span className="is-mark"><small>대상 파일</small>v2.xlsx</span></span>,
      },
      { title: "실행", text: "버전 비교 또는 값 일치 확인을 골라 실행", mini: <Run before={<Segments items={["버전 비교", "값 일치 확인"]} active={0} />} /> },
      { title: "결과 확인", text: "변경 내역 확인 및 다운로드", mini: <Result title="버전 비교 결과" status="비교 완료" lines={["중요 변경 2 · 추가 1 · 삭제 1"]} actions={["CSV", "XLSX 다운로드"]} /> },
    ],
    tip: "첫 번째 선택 파일이 기준 파일",
  },
  {
    id: "check", label: "검수", summary: "문장·일관성·데이터·개인정보·보안정보 검수",
    steps: [
      selectFiles("검수할 파일 선택", ["최종검수.pptx"]),
      { title: "실행", text: "검수 탭에서 실행", mini: <Run /> },
      { title: "결과 확인", text: "카드의 문제·수정 제안을 읽고 하단 액션 행의 ‘근거 보기’에서 원문 위치 확인. 분류 필터로 좁혀 볼 수 있습니다", mini: <Result status="검수 완료" lines={["발견한 문제 → 수정 제안", "원문 위치 · 하단 액션"]} actions={["근거 보기"]} /> },
      { title: "제외·무시", text: "‘근거 보기’와 같은 행의 버튼을 사용합니다. ‘이번 항목 제외’는 현재 항목만, ‘동일 규칙 무시’는 같은 규칙의 항목에 적용. 무시한 규칙은 이 브라우저에 저장", mini: <Result status="결과 갱신" lines={["중요 · 주의 · 제안 건수 갱신"]} actions={["이번 항목 제외", "동일 규칙 무시"]} /> },
    ],
  },
  {
    id: "supplement", label: "보완", summary: "문서에서 빠진 핵심 정보와 설명이 필요한 부분 확인",
    steps: [
      selectFiles("보완할 문서 파일 선택", ["3분기_비용보고.pptx"]),
      { title: "실행", text: "보완 실행 선택 · 진행 상태는 실행 버튼에 표시", mini: <Run /> },
      { title: "결과 확인", text: "상단 요약에서 자료 유형과 분석 완료 여부를 확인합니다. 카드의 보완할 문제와 필요한 정보를 읽고, 항목 제목을 펼쳐 확인 이유와 ‘근거 보기’를 확인합니다", mini: <Result status="검토 완료" lines={["자료 유형 · 분석 완료 여부", "보완할 문제 → 필요한 정보", "상세 펼침 → 확인 이유 · 근거 보기"]} /> },
      { title: "질문·근거 확인", text: "‘보고 전 확인할 질문’을 펼쳐 질문을 확인합니다. 항목별 ‘근거 보기’에서 현재 자료·인용 원문·위치를 확인하고, 닫으면 해당 버튼으로 돌아옵니다", mini: <Result status="상세 확인" lines={[]} actions={["보고 전 확인할 질문", "근거 보기"]} /> },
    ],
    tip: "다른 페이지의 설명은 누락으로 표시하지 않으며, 읽지 못한 영역은 분석 범위에 표시",
  },
  {
    id: "polish", label: "윤문", summary: "번역투와 중복 표현을 문장 단위로 다듬습니다.",
    steps: [
      { title: "입력 방식 선택", text: "파일 윤문은 파일 선택, 텍스트 윤문은 내용 붙여넣기. 모드를 바꿔도 기존 파일과 입력 내용은 유지됩니다", mini: <Segments items={["파일 윤문", "텍스트 윤문"]} active={1} /> },
      { title: "윤문 방식 선택 후 실행", text: "기본·간결하게·업무 문체 중 선택. 텍스트 윤문은 입력창 오른쪽 글자 수 아래에서 실행", mini: <Run before={<Segments items={["기본", "간결하게", "업무 문체"]} active={0} />} /> },
      { title: "결과 확인", text: "원문과 수정문 비교", mini: <Result status="윤문 완료" lines={["원문 → 수정문"]} /> },
    ],
  },
  {
    id: "extract", label: "추출", summary: "필요한 항목과 값을 찾아 표로 정리",
    steps: [
      selectFiles("추출할 파일 선택", ["주요값_A.xlsx"]),
      { title: "방식 선택 후 실행", text: "자동 추출 또는 항목 지정을 골라 실행", mini: <Run before={<Segments items={["자동 추출", "항목 지정"]} active={0} />} /> },
      { title: "결과 내려받기", text: "표 확인 및 다운로드", mini: <Result status="추출 완료" lines={["항목 · 값 · 근거"]} actions={["CSV", "XLSX 다운로드"]} /> },
    ],
  },
  {
    id: "aggregate", label: "취합", summary: "첫 번째 파일의 서식을 기준으로 여러 Excel 표 취합",
    steps: [
      selectFiles("취합할 Excel 파일 선택", ["9월_실적.xlsx", "10월_실적.xlsx"]),
      { title: "기준 파일 확인", text: "첫 번째 파일이 기준 파일로 표시", mini: <Files><Row name="9월_실적.xlsx" checked role="기준 파일" mark /><Row name="10월_실적.xlsx" checked /></Files> },
      { title: "실행", text: "취합 탭에서 실행", mini: <Run /> },
      { title: "결과 내려받기", text: "결과 시트 확인 및 다운로드", mini: <Result status="취합 완료" lines={["결과 시트 1개"]} actions={["XLSX 다운로드"]} /> },
    ],
    tip: "첫 번째 파일의 서식을 기준으로 취합하며, Excel 파일만 지원",
  },
  {
    id: "law", label: "법령", summary: "현행 법령과 판례·결정례 조회",
    steps: [
      { title: "법령 검색", text: "법령명을 입력해 검색", mini: <span className="mini-operation"><Field text="근로기준법" /><span className="mini-button">검색</span></span> },
      { title: "결과 선택", text: "목록에서 법령 선택", mini: <span className="mini-files"><span className="mini-row is-mark"><span className="mini-name">근로기준법</span><b className="mini-role">현행</b></span><span className="mini-row"><span className="mini-name">근로기준법 시행령</span></span></span> },
      { title: "조문 확인", text: "조문 확인 후 관련 판례·결정례 조회", mini: <Result title="제23조(해고 등의 제한)" status="현행" lines={["① 사용자는 근로자에게 정당한 이유 없이…"]} actions={["관련 판례·결정례"]} /> },
      { title: "종합 리서치", text: "쟁점별 핵심 검토 결과·근거 상태·추가 확인을 먼저 읽고, ‘쟁점 바로가기’로 이동. 관련 법령·판례는 쟁점별로 펼쳐 봅니다", mini: <Result title="01 퇴직금 · 02 해고" status="근거 확인" lines={["핵심 검토 결과 · 근거 상태 · 추가 확인"]} actions={["관련 법령·판례 상세 보기"]} /> },
    ],
    tip: "인용 전 시행 시점과 국가법령정보센터 원문을 대조하세요. 문서 검토의 ‘검토한 내용 보기’는 업로드 문서의 해당 부분을, ‘근거 보기’는 관련 법령·판례를 보여 줍니다. ‘전체 펼치기 / 전체 접기’는 관련 근거만 조작",
  },
  {
    id: "pdf", label: "PDF 도구", summary: "PDF 페이지 정리 및 원하는 형식으로 내보내기",
    steps: [
      { title: "PDF 추가", text: "여러 PDF 추가 가능", mini: <Upload label="PDF 추가" hint="원본 파일은 수정되지 않습니다" /> },
      { title: "페이지 정리", text: "끌어서 순서 변경·회전·삭제", mini: <span className="mini-pages">{[1, 2, 3].map((page) => <span key={page} className={page === 2 ? "is-mark" : undefined}>{page}</span>)}</span> },
      { title: "완성본 저장", text: "PDF·JPG·PNG 중 형식을 골라 저장", mini: <Run label="저장" before={<Segments items={["PDF", "JPG", "PNG"]} active={0} />} /> },
    ],
    tip: "불러오는 동안 진행 개수와 파일명이 표시됩니다. 다른 메뉴로 이동하면 불러오기가 중단되고 편집 작업이 정리됩니다. 편집 내용을 유지하려면 이동 전 저장하세요",
  },
  {
    id: "image", label: "이미지 도구", summary: "이미지 편집 또는 여러 장 결합 후 내보내기",
    steps: [
      { title: "이미지 추가", text: "JPG·PNG·WebP 이미지 추가", mini: <Upload label="이미지 추가" hint="JPG · PNG · WebP" /> },
      { title: "편집", text: "크기·회전 등 편집 적용", mini: <span className="mini-canvas"><ImageIcon className="mini-canvas-icon" /><span className="mini-crop is-mark" /></span> },
      { title: "결과 내보내기", text: "편집 또는 결합한 이미지 내보내기", mini: <Run label="내보내기" before={<Field text="2개 선택됨" mark={false} />} /> },
    ],
  },
  {
    id: "ax", label: "업무 자동화 진단", summary: "업무 등록 후 자동화 가능성·우선순위·실행 계획 확인",
    steps: [
      { title: "업무 등록", text: "업무 설명 입력, 필요하면 업무명·자료 추가", mini: <Run label="업무 등록" before={<Field text="자료 취합과 승인 절차" />} /> },
      { title: "업무 진단", text: "업무 특성과 자동화 가능성 진단", mini: <Result title="진단 결과" status="진단 완료" lines={["반복성 · 규칙성 · 데이터 구조화", "시스템 접근성 · 담당자 판단 · 위험"]} /> },
      { title: "자동화 매트릭스", text: "업무별 가치와 실현 가능성 비교", mini: <Result title="자동화 매트릭스" status="진단 업무" lines={["빠른 실행 후보 · 전략 과제", "검토 후보 · 수동 유지·보류"]} /> },
      { title: "결과·로드맵", text: "구현 범위·시작 전 확인·완료 기준 검토 후 Codex 또는 Claude Code용 지시문 생성. 접힌 지시문도 전체 복사 가능", mini: <Result title="결과·로드맵" status="검토 대기" actions={["Codex · Claude Code"]} lines={["01 구현 범위 → 02 시작 전 확인 → 03 완료 기준", "04 코딩 에이전트 지시문 · 전체 복사"]} /> },
    ],
    tip: "매트릭스의 위치나 우선순위만으로 구현을 승인할 수 없습니다. 진행 전 선행 조건과 담당자 검토·승인 및 필요한 검증을 확인하세요",
  },
  {
    id: "dictionary", label: "용어 사전", summary: "맞춤법·용어 오탐을 줄이는 사전",
    steps: [
      { title: "용어 사전 열기", text: "왼쪽 메뉴(좁은 화면에서는 메뉴 버튼)의 HELP에서 ‘용어 사전’ 선택", mini: <span className="mini-files"><span className="mini-row"><span className="mini-name">사용 가이드</span></span><span className="mini-row is-mark is-checked"><span className="mini-name">용어 사전</span></span><span className="mini-row"><span className="mini-name">설정</span></span></span> },
      { title: "단어 추가", text: "회사 용어를 개인 사전에 추가", mini: <span className="mini-operation"><Field text="WorkLens" /><span className="mini-button">추가</span></span> },
      { title: "검수에 반영", text: "추가한 단어는 맞춤법 오류에서 제외", mini: <Result title="개인 사전" status="1개" lines={["WorkLens"]} /> },
    ],
    tip: "개인 사전은 이 브라우저에만 저장",
  },
];

export function UsageGuide() {
  const [active, setActive] = useState(GUIDES[0].id);

  return (
    <section className="usage-guide" aria-label="사용 가이드">
      <Tabs value={active} onValueChange={(value) => setActive(String(value))}>
      <TabsList className="usage-guide-tabs max-w-full" aria-label="기능 선택" variant="underline" activateOnFocus>
        {GUIDES.map((entry) => <TabsTab key={entry.id} value={entry.id}>{entry.label}</TabsTab>)}
      </TabsList>
      {GUIDES.map((guide) => <TabsPanel key={guide.id} value={guide.id} className="usage-guide-panel">
        <header className="usage-guide-head">
          <h2>{guide.label}</h2>
          <p>{guide.summary}</p>
        </header>
        <ol className="usage-guide-flow" data-steps={guide.steps.length}>
          {guide.steps.map((step, index) => (
            <li key={step.title} className="usage-guide-step">
              <span className="usage-guide-badge">STEP {String(index + 1).padStart(2, "0")}</span>
              <span className="usage-guide-mini" aria-hidden="true">{step.mini}</span>
              <strong>{step.title}</strong>
              <span className="usage-guide-text">{step.text}</span>
              {index < guide.steps.length - 1 ? (
                <span className="usage-guide-arrow" aria-hidden="true"><ArrowRight className="is-row" /><ArrowDown className="is-column" /></span>
              ) : null}
            </li>
          ))}
        </ol>
        {guide.tip ? <p className="usage-guide-tip"><b>TIP</b>{guide.tip}</p> : null}
      </TabsPanel>)}
      </Tabs>
    </section>
  );
}
