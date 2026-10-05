"use client";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { MoreHorizontal, Upload, Download, Trash2, ClipboardList, CircleCheck, Zap, Clock3, Stethoscope, LayoutGrid, Map as MapIcon, ArrowLeft, ArrowRight, Paperclip, FileText, X, Repeat, CalendarCheck, Database, Plug, UserCheck, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { AlertDialog, AlertDialogPopup, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogClose } from "@/components/ui/alert-dialog";
import { useAxState } from "@/client/use-ax-state";
import { runInWorker } from "@/client/document-client";
import { diagnoseAx, planAx, interruptServerAi, aiFailureDetail } from "@/client/server-ai-client";
import { AX_LIMITS, FACTOR_LABELS, axTaskSchema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { axes, automationLevel, bubbleArea, executionGate, GATE_LABELS, planAllowed, priorityDisplayLabel, factorScale, matrixPosition, monthlyMinutes, nextAction, priority, REGION_LABELS, taskStatus } from "@/lib/ax/policy";
import { candidateTask, taskDetails, followUpDescription, legacyDetailValues, validateAttachmentPreflight } from "@/lib/ax/registration";
import { exportAxState, importAxState } from "@/lib/ax/transfer";
import { emptyAxState, type AxState, type AxTask, type AxDiagnosis, type AxDetails, type FactorKey } from "@/lib/ax/types";
import { AxSummary, AxProcess, AxRoadmap, AxPlanSection, AxRadar } from "./AxReport";
import "./ax.css";

const STEPS = ["업무 등록", "업무 진단", "자동화 매트릭스", "결과·로드맵"];
const STEP_ICONS = [ClipboardList, Stethoscope, LayoutGrid, MapIcon];
const FACTOR_META = {
  repetition: { icon: Repeat, color: "#4f46e5" }, regularity: { icon: CalendarCheck, color: "#2563eb" },
  dataStructure: { icon: Database, color: "#0d9488" }, systemAccess: { icon: Plug, color: "#d97706" },
  humanJudgment: { icon: UserCheck, color: "#db2777" }, operationalRisk: { icon: AlertTriangle, color: "#dc2626" },
};
const STATUS = { registered: "등록됨", "needs-info": "정보 확인 필요", diagnosed: "진단 완료", adjusted: "사용자 보정 완료" };
const SUFFICIENCY = { sufficient: "정보 충분", partial: "정보 일부 부족", "needs-check": "핵심 정보 확인 필요" };
const DETAILS: { key: keyof AxDetails; label: string; numeric?: boolean }[] = [
  { key: "cycle", label: "수행 주기" }, { key: "minutesPerRun", label: "1회 소요 시간(분)", numeric: true },
  { key: "runsPerMonth", label: "월 수행 횟수", numeric: true },
  { key: "systems", label: "사용 시스템" }, { key: "inputs", label: "입력 자료" }, { key: "outputs", label: "산출물" },
  { key: "humanSteps", label: "사람이 처리/판단하는 단계" },
];
type SessionAttachment = { meta: NonNullable<AxTask["attachmentMeta"]>; summary: string };
type Confirmation = { kind: "import"; state: AxState } | { kind: "reset" } | { kind: "delete"; id: string };

export function AxDiagnosisView() {
  const { state, update, replace, ready, saveStatus, loadNotice, externalChange } = useAxState();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const activeRun = useRef(false), activeAi = useRef(false), alive = useRef(true);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState<Partial<Record<keyof AxDetails, string>>>({});
  const [draftAttachment, setDraftAttachment] = useState<SessionAttachment | null>(null);
  const attachments = useRef(new Map<string, SessionAttachment>());
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const importInput = useRef<HTMLInputElement>(null);
  const nameHelpId = useId();
  const selected = state.tasks.find(t => t.id === state.selectedTaskId);
  const ranked = priority(state.tasks);
  useEffect(() => {
    alive.current = true;
    const sessionAttachments = attachments.current;
    return () => { alive.current = false; if (activeAi.current) interruptServerAi(); sessionAttachments.clear(); };
  }, []);
  function patchTask(id: string, patch: Partial<AxTask>) {
    update(current => ({ ...current, tasks: current.tasks.map(t => t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t) }));
  }
  function select(id: string) { update(current => ({ ...current, selectedTaskId: id })); }
  function changeStep(step: number) { update(current => ({ ...current, step })); setMessage(""); }
  function clearDraft() { setName(""); setDescription(""); setDetails({}); setDraftAttachment(null); setEditingId(null); }
  function editTask(task: AxTask) {
    setEditingId(task.id); setName(task.name); setDescription(task.description);
    setDetails(Object.fromEntries(Object.entries(taskDetails(task)).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
    setDraftAttachment(attachments.current.get(task.id) ?? null); changeStep(1);
  }
  function register(event: FormEvent) {
    event.preventDefault();
    try {
      if (!editingId && state.tasks.length >= AX_LIMITS.tasks) throw new Error("등록은 최대 100개까지 가능합니다.");
      const inputs = Object.fromEntries(DETAILS.flatMap(({ key, numeric }) => {
        const value = details[key]?.trim(); return value ? [[key, numeric ? Number(value) : value]] : [];
      }));
      const previous = state.tasks.find(t => t.id === editingId);
      const task = axTaskSchema.parse({ ...candidateTask(description), ...(previous ? legacyDetailValues(previous) : {}), ...inputs, name: name.trim() || description.trim().slice(0, 60),
        ...(previous ? { id: previous.id, createdAt: previous.createdAt } : {}),
        ...((draftAttachment?.meta ?? previous?.attachmentMeta) ? { attachmentMeta: draftAttachment?.meta ?? previous?.attachmentMeta } : {}),
      });
      if (draftAttachment) { attachments.current.set(task.id, draftAttachment); setAttachmentIds(current => [...new Set([...current, task.id])]); }
      update(current => ({ ...current, tasks: editingId ? current.tasks.map(t => t.id === editingId ? task : t) : [...current.tasks, task], selectedTaskId: task.id }));
      clearDraft(); setMessage(previous ? "등록 정보를 수정했습니다. 변경된 정보로 다시 진단하세요." : "업무를 등록했습니다.");
    } catch { setMessage("등록 정보를 확인하세요. 설명은 필수이며 입력값의 길이와 숫자 범위를 확인해야 합니다."); }
  }
  async function attach(file: File, taskId?: string) {
    if (activeRun.current) return;
    try { validateAttachmentPreflight(file); } catch (error) { setMessage(error instanceof Error ? error.message : "첨부 파일을 확인하세요."); return; }
    activeRun.current = true; setBusy("attachment"); setMessage("");
    const fileId = `ax-${crypto.randomUUID()}`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const parsed = await runInWorker({ kind: "parse", fileId, fileName: file.name, bytes }, [bytes.buffer]);
      const [analyzed] = await runInWorker({ kind: "analyze", fileIds: [fileId] });
      const summary = [`문서 유형: ${parsed.kind}`, `구조: 문단 ${analyzed.analysis.structure.paragraphCount}개, 표 ${analyzed.analysis.structure.tableCount}개`,
        ...analyzed.topics.slice(0, 8).map(t => `주요 업무 단서: ${t.text.slice(0, 180)}`)].join("\n").slice(0, AX_LIMITS.attachmentSummary);
      const attachment: SessionAttachment = { meta: { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, fingerprint: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") }, summary };
      if (!alive.current) return;
      if (taskId) { attachments.current.set(taskId, attachment); setAttachmentIds(current => [...new Set([...current, taskId])]); patchTask(taskId, { attachmentMeta: attachment.meta, diagnosis: undefined, status: "registered" }); }
      else setDraftAttachment(attachment);
      setMessage("첨부 요약을 준비했습니다. 진단 실행 시 요약만 AI에 전송됩니다.");
    } catch { if (alive.current) setMessage("첨부 파일을 읽지 못했습니다. 지원 형식과 파일 상태를 확인하세요."); }
    finally { await runInWorker({ kind: "forget", fileIds: [fileId] }).catch(() => undefined); activeRun.current = false; if (alive.current) setBusy(null); }
  }
  async function diagnose(task: AxTask, withAnswers = false) {
    if (activeRun.current) return;
    const attachment = attachments.current.get(task.id);
    if (task.attachmentMeta && !attachment) { setMessage("첨부 파일이 사용됨 — 재분석 시 재첨부 필요"); return; }
    const revised = withAnswers ? followUpDescription(task.description, task.diagnosis?.followUpQuestions ?? [], answers[task.id] ?? []) : task.description;
    if (withAnswers) {
      if (revised === task.description) { setMessage("추가 질문에 답변을 입력하세요."); return; }
      if (revised.length > AX_LIMITS.description) { setMessage("답변을 포함한 설명은 3,000자 이하여야 합니다. 등록 정보를 수정해 정리하세요."); return; }
    }
    activeRun.current = true; activeAi.current = true; setBusy(task.id); setMessage("");
    try {
      const output = await diagnoseAx({ kind: "ax-diagnosis", name: task.name, description: revised, details: taskDetails(task), ...(attachment ? { attachmentSummary: attachment.summary } : {}) });
      if (!alive.current) return;
      const diagnosis: AxDiagnosis = { ...output, sourceNote: attachment ? "첨부 파일 요약 기반 진단 · 첨부 파일이 사용됨 — 재분석 시 재첨부 필요" : "사용자 등록 정보 기반 진단" };
      patchTask(task.id, { diagnosis, status: taskStatus(diagnosis) });
      setAnswers(current => ({ ...current, [task.id]: [] })); setMessage("업무 진단을 완료했습니다. AI 근거를 확인하고 필요하면 점수를 보정하세요.");
    } catch (error) { if (alive.current) setMessage(`진단 실패 · ${aiFailureDetail(error)}`); }
    finally { activeAi.current = false; activeRun.current = false; if (alive.current) setBusy(null); }
  }
  function adjust(task: AxTask, key: FactorKey, input: string) {
    const value = input === "" ? undefined : Number(input);
    if (!task.diagnosis || (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 5))) return;
    const diagnosis: AxDiagnosis = { ...task.diagnosis, planCodex: undefined, planClaude: undefined, factors: task.diagnosis.factors.map(f => f.key === key ? { ...f, finalValue: value } : f) };
    patchTask(task.id, { diagnosis, status: taskStatus(diagnosis) });
  }
  async function generatePlan(task: AxTask, target: "codex" | "claude") {
    if (!task.diagnosis || activeRun.current) return;
    if (!planAllowed(task.diagnosis)) { setMessage("현재 조건에서는 구현 계획을 생성할 수 없습니다. 선행 조치를 먼저 해결하세요."); return; }
    activeRun.current = true; activeAi.current = true; setBusy(target); setMessage("");
    try {
      const confirmed = confirmedAxDiagnosis(task.diagnosis);
      const plan = await planAx({ kind: "ax-plan", target, task: { name: task.name, description: task.description, details: taskDetails(task) }, diagnosis: confirmed });
      if (!alive.current) return;
      patchTask(task.id, { diagnosis: { ...task.diagnosis, [target === "codex" ? "planCodex" : "planClaude"]: plan } });
      setMessage("구현 계획을 생성했습니다.");
    } catch (error) { if (alive.current) setMessage(`계획 생성 실패 · ${aiFailureDetail(error)}`); }
    finally { activeAi.current = false; activeRun.current = false; if (alive.current) setBusy(null); }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([exportAxState(state)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `worklens-ax-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("AI•AX 데이터를 내보냈습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "AI•AX 데이터를 내보내지 못했습니다."); }
  }
  async function acceptImport(file: File) {
    try {
      if (file.size > AX_LIMITS.transferBytes) throw new Error("가져오기 파일은 8MB 이하여야 합니다.");
      const imported = importAxState(await file.text());
      if (state.tasks.length) setConfirmation({ kind: "import", state: imported });
      else { const saved = await replace(imported); attachments.current.clear(); setAttachmentIds([]); clearDraft(); setMessage(saved ? "AI•AX 데이터를 가져왔습니다." : "AI•AX 데이터를 가져왔으나 브라우저 저장에 실패했습니다. 내보내기로 보관하세요."); }
    } catch (error) { setMessage((error as Error).message); }
  }
  async function confirm() {
    if (!confirmation) return;
    const action = confirmation; setConfirmation(null);
    if (action.kind === "delete") {
      attachments.current.delete(action.id); setAttachmentIds(current => current.filter(id => id !== action.id));
      if (editingId === action.id) clearDraft();
      update(current => { const tasks = current.tasks.filter(t => t.id !== action.id); return { ...current, tasks, selectedTaskId: current.selectedTaskId === action.id ? tasks[0]?.id ?? null : current.selectedTaskId }; });
      setMessage("업무를 삭제했습니다.");
    } else {
      const saved = await replace(action.kind === "reset" ? emptyAxState() : action.state, action.kind === "reset");
      attachments.current.clear(); setAttachmentIds([]); clearDraft(); setAnswers({});
      setMessage(saved ? action.kind === "reset" ? "AI•AX 데이터를 초기화했습니다." : "AI•AX 데이터를 가져왔습니다." : "화면 데이터를 변경했으나 브라우저 저장에 실패했습니다. 새로고침 시 이전 데이터가 복원될 수 있습니다.");
    }
  }
  const diagnosedCount = state.tasks.filter(t => !!t.diagnosis).length;
  const nextStepDisabled = state.step === 1 ? state.tasks.length === 0 : diagnosedCount === 0;
  function taskRows(showDelete: boolean) {
    const tasks = state.step === 3 ? ranked.map(r => r.task) : state.tasks;
    return <ul className={`ax-task-rows${state.step === 3 ? " ax-matrix-list" : ""}`}>{tasks.map(task => {
      const l = task.diagnosis ? automationLevel(task.diagnosis) : null;
      const a = task.diagnosis ? axes(task.diagnosis) : null;
      const meta = state.step === 3 && a ? `가치 ${a.value} · 실현 ${a.feasibility}` : l ? `${l.label.replace(/^L\d+ /, "")} · Level ${l.level}` : STATUS[task.status];
      return <li key={task.id} className={selected?.id === task.id ? "is-selected" : undefined}><Button type="button" variant="ghost" className="ax-task-row-btn" aria-pressed={selected?.id === task.id} onClick={() => select(task.id)} disabled={!!busy}>
        <span className={`ax-dot ax-dot-${task.status}`} aria-hidden="true" /><span className="ax-task-name">{task.name}</span><span className="ax-task-meta">{meta}</span>
      </Button>{showDelete && state.step === 1 ? <Button type="button" variant="ghost" className="ax-delete-button" aria-label="업무 삭제" disabled={!!busy} onClick={() => setConfirmation({ kind: "delete", id: task.id })}><Trash2 size={15} aria-hidden="true" /></Button> : null}</li>;
    })}</ul>;
  }
  function priorityRows(top = false) {
    const gateOrder = { ready: 0, conditional: 1, blocked: 2 };
    const displayed = [...ranked].sort((a, b) => gateOrder[executionGate(a.task.diagnosis)] - gateOrder[executionGate(b.task.diagnosis)]);
    return <ol className="ax-priority-list" aria-label={top ? "자동화 우선순위 TOP 목록" : "자동화 우선순위 목록"}>{(top ? displayed.slice(0, 3) : displayed).map((r, i) => {
      const l = automationLevel(r.task.diagnosis), m = matrixPosition(r.task.diagnosis), gate = executionGate(r.task.diagnosis);
      return <li key={r.task.id}><Button type="button" variant="ghost" className="ax-priority-row" aria-pressed={selected?.id === r.task.id} onClick={() => select(r.task.id)} disabled={!!busy}>
        <strong className="ax-rank">#{i + 1}</strong><span className="ax-priority-content"><span className="ax-priority-head"><span className="ax-task-name">{r.task.name}</span><span className="ax-region-chip" data-region={m.region}>{priorityDisplayLabel(r.task.diagnosis)}</span>{gate === "conditional" ? <span className="ax-gate-cond" title={GATE_LABELS[gate]}>조건부</span> : null}</span>
        <span>{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</span>{top ? <small className="ax-next-action"><span>다음 권장 행동</span>{nextAction(r.task.diagnosis).label}</small> : <small>{r.reason}</small>}{top ? <small>점수 {r.score}</small> : null}</span>
      </Button></li>;
    })}</ol>;
  }
  function detach(task: AxTask) {
    attachments.current.delete(task.id); setAttachmentIds(current => current.filter(id => id !== task.id));
    patchTask(task.id, { attachmentMeta: undefined, diagnosis: undefined, status: "registered" });
    setMessage("첨부를 해제했습니다. 등록 정보로 다시 진단할 수 있습니다.");
  }
  function attachmentStatus(task: AxTask) {
    if (!task.attachmentMeta) return null;
    const inSession = attachmentIds.includes(task.id);
    return <div className="ax-attachment"><p>{task.attachmentMeta.name} · {inSession ? "세션 요약 준비됨" : "첨부 파일이 사용됨 — 재분석 시 재첨부 필요"}</p>
      {inSession ? <Button type="button" variant="ghost" disabled={!!busy} onClick={() => detach(task)}>첨부 해제</Button> : <AxAttachmentInput disabled={!!busy} onSelect={file => void attach(file, task.id)} />}</div>;
  }
  return <section className="ax-view" aria-label="업무 자동화 진단" aria-busy={!!busy}>
    <div className="ax-data-actions">
      <Menu><MenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="AI•AX 데이터 작업" disabled={!ready || !!busy} />}><MoreHorizontal aria-hidden="true" /></MenuTrigger><MenuPopup align="end">
        <MenuItem onClick={download}><Upload aria-hidden="true" />AI•AX 데이터 내보내기</MenuItem>
        <MenuItem onClick={() => importInput.current?.click()}><Download aria-hidden="true" />AI•AX 데이터 가져오기</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => setConfirmation({ kind: "reset" })}><Trash2 aria-hidden="true" />AI•AX 데이터 초기화</MenuItem>
      </MenuPopup></Menu>
      <input ref={importInput} type="file" hidden accept=".json,application/json" aria-label="AI•AX 데이터 가져오기 파일" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void acceptImport(file); }} />
    </div>
    {saveStatus === "저장 실패" ? <p role="status" className="ax-notice">자동 저장에 실패했습니다. 필요하면 AI•AX 데이터를 내보내 백업해주세요.</p> : null}
    {loadNotice ? <p role="status" className="ax-notice">{loadNotice}</p> : null}
    {externalChange ? <p role="status" className="ax-notice">다른 탭에서 AI•AX 데이터가 변경되었습니다. 최신 내용을 보려면 새로고침하세요. <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>새로고침</Button></p> : null}
    {message ? <p role="status" className="ax-notice">{message}</p> : null}
    {!ready ? <p role="status">AI•AX 데이터를 불러오는 중…</p> : <Tabs value={String(state.step)} onValueChange={value => changeStep(Number(value))}>
      <TabsList className="ax-steps" aria-label="진단 단계">{STEPS.map((s, i) => { const Icon = STEP_ICONS[i]; return <TabsTab key={s} value={String(i + 1)} disabled={!!busy}><Icon size={15} aria-hidden="true" /><span>{s}</span></TabsTab>; })}</TabsList>
      <TabsPanel value="1">
        <div className="ax-step1-grid">
          <form className="ax-surface ax-register ax-area-form" onSubmit={register}><h2>{editingId ? "등록 정보 수정" : "업무 등록"}</h2>
            <div className="ax-field"><label className="ax-field">업무명<Input type="text" value={name} maxLength={AX_LIMITS.name} onChange={e => setName(e.target.value)} disabled={!!busy} aria-describedby={nameHelpId} /></label><small id={nameHelpId}>비워두면 업무 설명을 기준으로 자동 생성됩니다.</small></div>
            <label className="ax-field"><span className="ax-required-label">업무 설명</span><Textarea value={description} required maxLength={AX_LIMITS.description} onChange={e => setDescription(e.target.value)} disabled={!!busy} placeholder="어떤 업무를 반복하고 있으며, 어떤 자료를 받아 어떤 결과를 만드는지 설명해주세요." rows={5} /></label>
            <div className="ax-register-files">
              <AxAttachmentInput disabled={!!busy} onSelect={file => void attach(file)} />
              {draftAttachment ? <div className="ax-file-row"><FileText className="size-4" aria-hidden="true" /><span className="ax-file-name">{draftAttachment.meta.name}</span><span className="ax-file-status">준비됨</span><Button type="button" variant="ghost" size="icon-xs" aria-label="첨부 취소" onClick={() => setDraftAttachment(null)} disabled={!!busy}><X aria-hidden="true" /></Button></div> : null}
            </div>
            <Accordion><AccordionItem value="details">
              <div className="ax-register-actions"><AccordionTrigger type="button" className="ax-details-trigger" disabled={!!busy}>추가 정보</AccordionTrigger><div className="ax-register-submit">{editingId ? <Button type="button" variant="ghost" onClick={clearDraft}>수정 취소</Button> : null}<Button type="submit" disabled={!!busy || !description.trim()}>{editingId ? "수정 저장" : "업무 등록"}</Button></div></div>
              <AccordionPanel><div className="ax-form-grid">{DETAILS.map(({ key, label, numeric }) => <label className="ax-field" key={key}>{label}<Input type={numeric ? "number" : "text"} min={numeric ? 0 : undefined} max={numeric ? 100000 : undefined} step="any" maxLength={numeric ? undefined : AX_LIMITS.detail} value={details[key] ?? ""} onChange={e => setDetails(current => ({ ...current, [key]: e.target.value }))} disabled={!!busy} /></label>)}</div></AccordionPanel>
            </AccordionItem></Accordion>
          </form>
          <section className="ax-surface ax-area-list" aria-label="등록 업무 목록"><h3>업무 목록</h3>{state.tasks.length ? taskRows(true) : <AxEmptyState title="등록된 업무가 없습니다" description="왼쪽에서 첫 업무를 등록해주세요." />}</section>
          {state.tasks.length ? <aside className="ax-step1-side ax-area-side"><AxKpiCards tasks={state.tasks} /></aside> : null}
        </div>
      </TabsPanel>
      <TabsPanel value="2">
        {!state.tasks.length ? <AxEmptyState title="진단할 업무가 없습니다" description="업무를 먼저 등록해주세요." /> : <div className="ax-step2-grid">
          <section className="ax-surface" aria-label="등록 업무 목록"><h3>업무 목록</h3>{taskRows(false)}</section>
          <div className="ax-detail-col">{selected ? <>
            <section className="ax-surface"><div className="ax-section-heading"><div className="ax-title-group"><h2>{selected.name}</h2><Badge className="ax-status-badge">{STATUS[selected.status]}</Badge></div><Button type="button" variant="outline" size="sm" className="ax-edit-button" onClick={() => editTask(selected)} disabled={!!busy}>등록 정보 수정</Button></div><p>{selected.description}</p>
              {attachmentStatus(selected)}<div className="ax-actions"><Button type="button" disabled={!!busy} onClick={() => void diagnose(selected)}>{busy === selected.id ? "진단 중…" : selected.diagnosis ? "업무 다시 진단" : "업무 진단 실행"}</Button>{busy && busy !== "attachment" ? <Button type="button" variant="ghost" onClick={interruptServerAi}>AI 작업 중지</Button> : null}</div>
              {selected.diagnosis ? <AxSummary task={selected} /> : null}
            </section>
            {selected.diagnosis ? <>
              <section className="ax-surface"><h3>진단 항목</h3><p className="ax-muted">필요하면 AI 평가값을 조정할 수 있습니다. 변경한 값은 자동화 수준과 우선순위에 바로 반영됩니다.</p>
                {selected.diagnosis.factors.map(f => { const { icon: Icon, color } = FACTOR_META[f.key], effective = f.finalValue ?? f.aiValue; const style = { "--ax-factor": color } as CSSProperties; return <div className="ax-factor-row" key={f.key}>
                  <span className="ax-factor-icon" style={style}><Icon size={16} aria-hidden="true" /></span>
                  <div className="ax-factor-main"><div className="ax-factor-head"><h4>{FACTOR_LABELS[f.key]}</h4><span className="ax-muted">AI {f.aiValue}점</span>{f.finalValue !== undefined ? <span className="ax-factor-corrected">사용자 보정</span> : null}</div><p>{f.rationale}</p><small>{factorScale(f.key)}</small></div>
                  <div className="ax-factor-control"><div className="ax-segments" role="group" aria-label={`${FACTOR_LABELS[f.key]} 보정`}>{[1, 2, 3, 4, 5].map(v => <button type="button" key={v} className={v <= effective ? "is-on" : ""} style={style} aria-label={`${FACTOR_LABELS[f.key]} ${v}점`} aria-pressed={v === effective} disabled={!!busy} onClick={() => adjust(selected, f.key, String(v))} />)}</div><strong className="ax-factor-value" style={{ color }}>{effective}</strong>{f.finalValue !== undefined ? <Button type="button" variant="ghost" size="sm" onClick={() => adjust(selected, f.key, "")} disabled={!!busy}>AI 값으로</Button> : null}</div>
                </div>; })}
              </section>
              <div className="ax-step2-sub-grid"><section className="ax-surface"><h3>진단 요약</h3><Badge variant={selected.diagnosis.informationSufficiency === "sufficient" ? "success" : "warning"}>{SUFFICIENCY[selected.diagnosis.informationSufficiency]}</Badge><p className="ax-muted">{selected.diagnosis.sourceNote}</p><p className="ax-summary-level">자동화 수준 <strong>{automationLevel(selected.diagnosis).label.replace(/^L\d+ /, "")} · Level {automationLevel(selected.diagnosis).level}</strong></p><AxAxisBars diagnosis={selected.diagnosis} /></section><section className="ax-surface"><h3>진단 항목 분포</h3><AxRadar diagnosis={selected.diagnosis} /></section></div>
              {selected.diagnosis.followUpQuestions.length ? <section className="ax-surface ax-questions"><h3>추가 확인이 필요합니다</h3>{selected.diagnosis.followUpQuestions.map((q, i) => <label className="ax-field" key={i}>{q}<Textarea rows={2} maxLength={500} disabled={!!busy} value={answers[selected.id]?.[i] ?? ""} onChange={e => setAnswers(current => { const values = [...(current[selected.id] ?? [])]; values[i] = e.target.value; return { ...current, [selected.id]: values }; })} /></label>)}<Button type="button" variant="outline" disabled={!!busy} onClick={() => void diagnose(selected, true)}>답변 반영 재진단</Button></section> : null}
              <AxProcess diagnosis={selected.diagnosis} />
            </> : null}
          </> : null}</div>
        </div>}
      </TabsPanel>
      <TabsPanel value="3">
        {!ranked.length ? <AxEmptyState title="비교할 진단 결과가 없습니다" description="진단이 완료된 업무가 표시됩니다." /> : <div className="ax-step3-grid">
          <section className="ax-surface" aria-label="매트릭스 업무 목록"><h3>업무 목록</h3>{taskRows(false)}</section>
          <div className="ax-step3-main"><section className="ax-surface ax-matrix-surface"><div className="ax-matrix-header"><h2>자동화 매트릭스</h2><p className="ax-muted">자동화 가치와 기술 실현 가능성을 기준으로 업무를 비교합니다.</p></div><AxMatrix tasks={ranked.map(r => r.task)} selectedId={selected?.id} onSelect={select} /></section>
            <section className="ax-surface"><h3>자동화 우선순위</h3>{priorityRows()}</section>
            {selected?.diagnosis ? <section className="ax-surface"><h3>{selected.name} · {matrixPosition(selected.diagnosis).label}</h3><AxSummary task={selected} /><Button type="button" variant="outline" onClick={() => changeStep(2)}>점수·근거 확인</Button></section> : null}
          </div>
        </div>}
      </TabsPanel>
      <TabsPanel value="4">
        {!ranked.length ? <AxEmptyState title="아직 결과가 없습니다" description="업무 진단이 완료되면 실행 계획을 확인할 수 있습니다." /> : <>
          <AxKpiCards tasks={state.tasks} />
          <div className="ax-step4-grid"><div className="ax-step4-left">
            <section className="ax-surface"><h3>자동화 우선순위 TOP {Math.min(3, ranked.length)}</h3>{priorityRows(true)}</section>
            <section className="ax-surface"><h3>분류 현황</h3><div className="ax-region-tiles">{Object.entries(REGION_LABELS).map(([region, label]) => <div className="ax-region-tile" data-region={region} key={region}><span>{label}</span><strong>{ranked.filter(r => matrixPosition(r.task.diagnosis).region === region).length}개</strong></div>)}</div></section>
          </div><section className="ax-roadmap-panel"><h3>실행 로드맵</h3>{selected?.diagnosis ? <><p className="ax-roadmap-task">{selected.name}</p><ol className="ax-timeline">{selected.diagnosis.roadmap.map((r, i) => <li key={i}><span className="ax-timeline-node">{i + 1}</span><div><h4>Phase {r.phase} · {r.title}</h4><ul>{r.items.map((item, j) => <li key={j}>{item}</li>)}</ul></div></li>)}</ol></> : <p>우선순위에서 업무를 선택하면 실행 로드맵을 확인할 수 있습니다.</p>}</section></div>
          {selected?.diagnosis ? <div className="ax-detail-stack"><section className="ax-surface"><h2>{selected.name}</h2><p className="ax-muted">{selected.diagnosis.sourceNote}</p><AxSummary task={selected} /></section><AxRoadmap diagnosis={selected.diagnosis} roadmapSection={false} />
            <AxPlanSection key={selected.id} diagnosis={selected.diagnosis} busy={busy} onGenerate={target => void generatePlan(selected, target)} />
          </div> : <p className="ax-muted">우선순위 목록에서 업무를 선택해 상세 결과를 확인하세요.</p>}
        </>}
      </TabsPanel>
    </Tabs>}
    {ready ? <nav className="ax-step-nav" aria-label="단계 이동">
      {state.step > 1 ? <Button type="button" variant="outline" onClick={() => changeStep(state.step - 1)} disabled={!!busy}><ArrowLeft aria-hidden="true" />이전 단계</Button> : <span aria-hidden="true" />}
      {state.step < 4 ? <Button type="button" onClick={() => changeStep(state.step + 1)} disabled={!!busy || nextStepDisabled}><span>다음 단계</span><ArrowRight aria-hidden="true" /></Button> : <span aria-hidden="true" />}
    </nav> : null}
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogPopup><AlertDialogHeader><AlertDialogTitle>{confirmation?.kind === "import" ? "AI•AX 데이터를 덮어쓸까요?" : confirmation?.kind === "delete" ? "업무를 삭제할까요?" : "AI•AX 데이터를 초기화할까요?"}</AlertDialogTitle><AlertDialogDescription>{confirmation?.kind === "import" ? "검증된 가져오기 데이터로 현재 AI•AX 업무·진단·계획을 교체합니다." : confirmation?.kind === "delete" ? "선택한 업무와 진단·계획을 삭제합니다." : "현재 AI•AX 업무·진단·계획만 삭제합니다. 다른 작업 공간은 유지됩니다."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogClose render={<Button type="button" variant="ghost" />}>취소</AlertDialogClose><Button type="button" variant="destructive" onClick={() => void confirm()}>{confirmation?.kind === "import" ? "덮어쓰기" : confirmation?.kind === "delete" ? "삭제" : "초기화"}</Button></AlertDialogFooter></AlertDialogPopup></AlertDialog>
  </section>;
}
function AxEmptyState({ title, description }: { title: string; description: string }) {
  return <div className="ax-empty"><h3>{title}</h3><p className="ax-muted">{description}</p></div>;
}
function AxAttachmentInput({ disabled, onSelect }: { disabled: boolean; onSelect: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="ax-field ax-file-input">
    <input ref={input} type="file" hidden accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label="파일 추가" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) onSelect(file);
    }} />
    <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" />파일 추가</Button>
  </div>;
}
function AxKpiCards({ tasks }: { tasks: AxTask[] }) {
  const diagnosedCount = tasks.filter(t => !!t.diagnosis).length;
  const ranked = priority(tasks);
  const knownMinutes = tasks.map(monthlyMinutes).filter((m): m is number => m !== null);
  return <div className="ax-kpi-cards">
    <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><ClipboardList size={14} aria-hidden="true" />등록 업무</span><strong>{tasks.length}개</strong></div>
    <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><CircleCheck size={14} aria-hidden="true" />진단 완료</span><strong>{diagnosedCount}개</strong></div>
    {diagnosedCount ? <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><Zap size={14} aria-hidden="true" />우선 검토 후보</span><strong>{ranked.filter(r => matrixPosition(r.task.diagnosis).region === "quick" && executionGate(r.task.diagnosis) !== "blocked").length}개</strong></div> : null}
    {knownMinutes.length ? <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><Clock3 size={14} aria-hidden="true" />월 투입시간 합 · 입력 {knownMinutes.length}개</span><strong>{(knownMinutes.reduce((sum, m) => sum + m, 0) / 60).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}시간</strong></div> : null}
  </div>;
}
function AxAxisBars({ diagnosis }: { diagnosis: AxDiagnosis }) {
  const a = axes(diagnosis);
  return <div className="ax-axis-bars">{([
    ["자동화 가치", a.value, "var(--primary)"], ["기술 실현 가능성", a.feasibility, "var(--primary)"],
    ["사람 판단 의존도", a.judgment, "#db2777"], ["운영 위험", a.risk, "#dc2626"],
  ] as const).map(([label, value, color]) => <div className="ax-axis-row" key={label}><span>{label}</span><div className="ax-axis-track"><span style={{ width: `${value / 5 * 100}%`, background: color }} /></div><strong>{value}</strong></div>)}</div>;
}
function AxMatrix({ tasks, selectedId, onSelect }: { tasks: (AxTask & { diagnosis: AxDiagnosis })[]; selectedId?: string; onSelect: (id: string) => void }) {
  const max = Math.max(0, ...tasks.map(t => monthlyMinutes(t) ?? 0));
  return <div className="ax-matrix-desktop"><div className="ax-matrix" aria-label="자동화 매트릭스 산점도">
    <div className="ax-region ax-region-strategic">전략 과제</div><div className="ax-region ax-region-quick">빠른 실행 후보</div><div className="ax-region ax-region-hold">수동 유지·보류</div><div className="ax-region ax-region-maybe">검토 후보</div>
    {[1, 2, 3, 4, 5].map(v => <span key={v} className="ax-y-tick" style={{ bottom: `${(v - 1) / 4 * 100}%` }}>{v === 1 ? "" : v}</span>)}
    {[1, 2, 3, 4, 5].map(v => <span key={v} className="ax-x-tick" style={{ left: `${(v - 1) / 4 * 100}%` }}>{v}</span>)}
    {tasks.map((task, i) => { const m = matrixPosition(task.diagnosis); const diameter = Math.sqrt(bubbleArea(task, max) / Math.PI) * 2; return <button type="button" key={task.id} className={`ax-bubble${m.region === "hold" ? " is-hold" : ""}`} style={{ left: `${m.x}%`, bottom: `${m.y}%`, width: Math.max(24, diameter), height: Math.max(24, diameter), zIndex: selectedId === task.id ? 3 : 2 }} aria-label={`${task.name} · ${m.label}`} aria-pressed={selectedId === task.id} title={`${task.name} · ${m.label}`} onClick={() => onSelect(task.id)}><span className="ax-bubble-dot" style={{ width: diameter, height: diameter }} /><span className="ax-bubble-number">{i + 1}</span></button>; })}
    <span className="ax-y-label"><span className="ax-y-arrow" aria-hidden="true">↑</span><span className="ax-y-text">자동화 가치</span></span><span className="ax-x-label">기술 실현 가능성 →</span>
  </div></div>;
}
