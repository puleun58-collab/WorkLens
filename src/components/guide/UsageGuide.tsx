"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowRight, FileSpreadsheet, FileText, Image as ImageIcon } from "lucide-react";
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

function Result({ title, status, lines, actions }: { title: string; status: string; lines: string[]; actions?: string[] }) {
  return (
    <span className="mini-result">
      <span className="mini-result-head"><strong>{title}</strong><em>{status}</em></span>
      {lines.map((line) => <span className="mini-line" key={line}>{line}</span>)}
      {actions ? <span className="mini-actions">{actions.map((action, index) => <span key={action} className={index === actions.length - 1 ? "mini-button is-mark" : "mini-button is-quiet"}>{action}</span>)}</span> : null}
    </span>
  );
}

const Files = ({ children }: { children: ReactNode }) => <span className="mini-files">{children}</span>;

const selectFiles = (text = "작업할 파일을 선택합니다.", names = ["운임현황_v1.xlsx", "운임현황_v2.xlsx"]): Step => ({
  title: "파일 선택",
  text,
  mini: <Files>{names.map((name) => <Row key={name} name={name} checked mark />)}</Files>,
});
const upload: Step = { title: "파일 업로드", text: "파일을 끌어 놓거나 파일 추가를 누릅니다.", mini: <Upload /> };

const GUIDES: Guide[] = [
  {
    id: "analyze", label: "분석", summary: "선택한 파일의 핵심 요약과 확인된 항목·수치를 정리합니다.",
    steps: [
      upload,
      selectFiles("분석할 파일을 선택합니다.", ["회의자료.pptx"]),
      { title: "실행", text: "분석 탭에서 실행을 누릅니다.", mini: <Run /> },
      { title: "결과 확인", text: "요약과 수치의 근거 위치를 확인합니다.", mini: <Result title="분석 결과" status="분석 완료" lines={["핵심 요약", "확인된 수치 · 근거 Slide 3"]} /> },
    ],
    tip: "파일은 이 탭의 메모리에만 있으며, 새로고침하면 사라집니다.",
  },
  {
    id: "ask", label: "질문", summary: "선택한 파일을 근거로 질문에 답합니다.",
    steps: [
      selectFiles("근거로 삼을 파일을 선택합니다.", ["계약.docx"]),
      { title: "질문 입력", text: "확인할 내용을 입력합니다.", mini: <Field text="계약 기간은 언제까지인가요?" /> },
      { title: "실행", text: "실행을 누릅니다.", mini: <Run before={<Field text="질문 입력됨" mark={false} />} /> },
      { title: "답변 확인", text: "답변과 근거 위치를 함께 확인합니다.", mini: <Result title="답변" status="답변 완료" lines={["계약 기간 · 근거 2페이지"]} /> },
    ],
  },
  {
    id: "compare", label: "비교", summary: "두 파일의 변경 사항이나 여러 파일의 값 차이를 확인합니다.",
    steps: [
      selectFiles("비교할 두 파일을 선택합니다."),
      {
        title: "기준/대상 확인", text: "필요하면 기준/대상 바꾸기를 누릅니다.",
        mini: <span className="mini-map"><span><small>기준 파일</small>v1.xlsx</span><ArrowRight className="mini-arrow-icon" /><span className="is-mark"><small>대상 파일</small>v2.xlsx</span></span>,
      },
      { title: "실행", text: "버전 비교 또는 값 일치 확인을 고르고 실행합니다.", mini: <Run before={<Segments items={["버전 비교", "값 일치 확인"]} active={0} />} /> },
      { title: "결과 확인", text: "변경 내역을 확인하고 내려받습니다.", mini: <Result title="버전 비교 결과" status="비교 완료" lines={["중요 변경 2 · 추가 1 · 삭제 1"]} actions={["CSV", "XLSX 다운로드"]} /> },
    ],
    tip: "첫 번째로 선택한 파일이 기준 파일입니다.",
  },
  {
    id: "check", label: "검수", summary: "문장·일관성·데이터·개인정보·보안정보를 검수합니다.",
    steps: [
      selectFiles("검수할 파일을 선택합니다.", ["최종검수.pptx"]),
      { title: "실행", text: "검수 탭에서 실행을 누릅니다.", mini: <Run /> },
      { title: "결과 확인", text: "발견 항목과 근거 위치를 확인합니다.", mini: <Result title="검수 결과" status="검수 완료" lines={["문장 · 일관성 · 개인정보", "근거 Slide 2"]} /> },
    ],
  },
  {
    id: "polish", label: "윤문", summary: "번역투와 중복 표현을 문장 단위로 다듬습니다.",
    steps: [
      { title: "입력 방식 선택", text: "파일 또는 붙여넣은 텍스트를 고릅니다.", mini: <Segments items={["파일 윤문", "텍스트 윤문"]} active={1} /> },
      { title: "윤문 방식 선택 후 실행", text: "기본, 간결하게, 업무 문체 중 고릅니다.", mini: <Run before={<Segments items={["기본", "간결하게", "업무 문체"]} active={0} />} /> },
      { title: "결과 확인", text: "원문과 수정문을 비교해 확인합니다.", mini: <Result title="윤문 결과" status="윤문 완료" lines={["원문 → 수정문"]} /> },
    ],
  },
  {
    id: "extract", label: "추출", summary: "필요한 항목과 값을 찾아 표로 정리합니다.",
    steps: [
      selectFiles("추출할 파일을 선택합니다.", ["주요값_A.xlsx"]),
      { title: "방식 선택 후 실행", text: "자동 추출, 항목 지정, 전체 텍스트 중 고릅니다.", mini: <Run before={<Segments items={["자동 추출", "항목 지정", "전체 텍스트"]} active={0} />} /> },
      { title: "결과 내려받기", text: "표를 확인하고 내려받습니다.", mini: <Result title="추출 결과" status="추출 완료" lines={["항목 · 값 · 근거"]} actions={["CSV", "XLSX 다운로드"]} /> },
    ],
  },
  {
    id: "aggregate", label: "취합", summary: "여러 Excel 파일의 표 데이터를 하나의 파일로 취합합니다.",
    steps: [
      selectFiles("취합할 Excel 파일을 선택합니다.", ["9월_실적.xlsx", "10월_실적.xlsx"]),
      { title: "기준 파일 확인", text: "첫 번째 파일이 기준 파일로 표시됩니다.", mini: <Files><Row name="9월_실적.xlsx" checked role="기준 파일" mark /><Row name="10월_실적.xlsx" checked /></Files> },
      { title: "실행", text: "취합 탭에서 실행을 누릅니다.", mini: <Run /> },
      { title: "결과 내려받기", text: "결과 시트를 확인하고 내려받습니다.", mini: <Result title="취합 결과" status="취합 완료" lines={["결과 시트 1개"]} actions={["XLSX 다운로드"]} /> },
    ],
    tip: "첫 번째 파일의 서식을 기준으로 취합하며, Excel 파일만 취합할 수 있습니다.",
  },
  {
    id: "law", label: "법령", summary: "현행 법령과 판례·결정례를 조회합니다.",
    steps: [
      { title: "법령 검색", text: "법령명을 입력하고 검색합니다.", mini: <span className="mini-operation"><Field text="근로기준법" /><span className="mini-button">검색</span></span> },
      { title: "결과 선택", text: "목록에서 법령을 선택합니다.", mini: <span className="mini-files"><span className="mini-row is-mark"><span className="mini-name">근로기준법</span><b className="mini-role">현행</b></span><span className="mini-row"><span className="mini-name">근로기준법 시행령</span></span></span> },
      { title: "조문 확인", text: "조문을 읽고 관련 판례·결정례로 이어갑니다.", mini: <Result title="제23조(해고 등의 제한)" status="현행" lines={["① 사용자는 근로자에게 정당한 이유 없이…"]} actions={["관련 판례·결정례"]} /> },
    ],
    tip: "판례·결정례, 검증·분석, 종합 리서치는 법령 화면 상단 탭에서 고릅니다.",
  },
  {
    id: "pdf", label: "PDF 도구", summary: "PDF 페이지를 정리하고 원하는 형식으로 내보냅니다.",
    steps: [
      { title: "PDF 추가", text: "여러 PDF를 함께 추가할 수 있습니다.", mini: <Upload label="PDF 추가" hint="원본 파일은 수정되지 않습니다" /> },
      { title: "페이지 정리", text: "끌어서 순서를 바꾸고 회전·삭제합니다.", mini: <span className="mini-pages">{[1, 2, 3].map((page) => <span key={page} className={page === 2 ? "is-mark" : undefined}>{page}</span>)}</span> },
      { title: "완성본 저장", text: "PDF, JPG, PNG 중 형식을 골라 저장합니다.", mini: <Run label="저장" before={<Segments items={["PDF", "JPG", "PNG"]} active={0} />} /> },
    ],
  },
  {
    id: "image", label: "이미지 도구", summary: "이미지를 편집하거나 여러 장을 결합해 내보냅니다.",
    steps: [
      { title: "이미지 추가", text: "JPG, PNG, WebP 이미지를 추가합니다.", mini: <Upload label="이미지 추가" hint="JPG · PNG · WebP" /> },
      { title: "편집", text: "크기·회전과 영역 자르기를 조정합니다.", mini: <span className="mini-canvas"><ImageIcon className="mini-canvas-icon" /><span className="mini-crop is-mark" /></span> },
      { title: "결과 내보내기", text: "선택한 이미지나 결합 이미지를 내보냅니다.", mini: <Run label="내보내기" before={<Field text="2개 선택됨" mark={false} />} /> },
    ],
  },
  {
    id: "dictionary", label: "용어 사전", summary: "맞춤법과 용어 오탐을 줄이기 위한 사전입니다.",
    steps: [
      { title: "용어 사전 열기", text: "사이드바 하단의 용어 사전을 누릅니다.", mini: <span className="mini-files"><span className="mini-row"><span className="mini-name">사용 가이드</span></span><span className="mini-row is-mark is-checked"><span className="mini-name">용어 사전</span></span><span className="mini-row"><span className="mini-name">설정</span></span></span> },
      { title: "단어 추가", text: "회사에서 쓰는 용어를 개인 사전에 추가합니다.", mini: <span className="mini-operation"><Field text="WorkLens" /><span className="mini-button">추가</span></span> },
      { title: "검수에 반영", text: "추가한 단어는 맞춤법 오류로 표시하지 않습니다.", mini: <Result title="개인 사전" status="1개" lines={["WorkLens"]} /> },
    ],
    tip: "개인 사전은 이 브라우저에만 저장됩니다.",
  },
];

export function UsageGuide() {
  const [active, setActive] = useState(GUIDES[0].id);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const guide = GUIDES.find((entry) => entry.id === active) ?? GUIDES[0];

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const current = GUIDES.findIndex((entry) => entry.id === active);
    const step = keys[event.key];
    const next = step === -Infinity ? 0 : step === Infinity ? GUIDES.length - 1 : (current + step + GUIDES.length) % GUIDES.length;
    setActive(GUIDES[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <section className="usage-guide" aria-label="사용 가이드">
      <div className="usage-guide-tabs" role="tablist" aria-label="기능 선택" onKeyDown={onKey}>
        {GUIDES.map((entry, index) => (
          <button
            key={entry.id}
            ref={(node) => { tabs.current[index] = node; }}
            type="button"
            role="tab"
            id={`guide-tab-${entry.id}`}
            aria-selected={entry.id === active}
            aria-controls="guide-panel"
            tabIndex={entry.id === active ? 0 : -1}
            onClick={() => setActive(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="usage-guide-panel" id="guide-panel" role="tabpanel" aria-labelledby={`guide-tab-${guide.id}`}>
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
      </div>
    </section>
  );
}
