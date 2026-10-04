"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { MoreHorizontal, Upload, Download, Trash2 } from "lucide-react";
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
import { axes, automationLevel, bubbleArea, factorScale, matrixPosition, monthlyMinutes, priority, taskStatus } from "@/lib/ax/policy";
import { candidateTask, splitTasks, taskDetails } from "@/lib/ax/registration";
import { exportAxState, importAxState } from "@/lib/ax/transfer";
import { emptyAxState, type AxState, type AxTask, type AxDiagnosis, type AxDetails, type FactorKey } from "@/lib/ax/types";
import { AxSummary, AxProcess, AxRoadmap, AxPlanReport } from "./AxReport";
import "./ax.css";

const STEPS = ["업무 등록", "업무 진단", "자동화 매트릭스", "결과·로드맵"];
const STATUS = { registered: "등록됨", "needs-info": "정보 확인 필요", diagnosed: "진단 완료", adjusted: "사용자 보정 완료" };
const SUFFICIENCY = { sufficient: "정보 충분", partial: "정보 일부 부족", "needs-check": "핵심 정보 확인 필요" };
const DETAILS: { key: keyof AxDetails; label: string; numeric?: boolean }[] = [
  { key: "cycle", label: "수행 주기" }, { key: "minutesPerRun", label: "1회 소요 시간(분)", numeric: true },
  { key: "runsPerMonth", label: "월 수행 횟수", numeric: true }, { key: "people", label: "참여 인원", numeric: true },
  { key: "systems", label: "사용 시스템" }, { key: "inputs", label: "입력 자료" }, { key: "outputs", label: "산출물" },
  { key: "humanSteps", label: "사람이 처리하는 단계" }, { key: "painPoints", label: "불편·병목" }, { key: "goal", label: "자동화 목표" },
];
type SessionAttachment = { meta: NonNullable<AxTask["attachmentMeta"]>; summary: string };
type Confirmation = { kind: "import"; state: AxState } | { kind: "reset" } | { kind: "delete"; id: string };

export function AxDiagnosisView() {
  const { state, update, replace, ready, saveStatus, loadNotice } = useAxState();
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
  const [batchText, setBatchText] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
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
      const task = axTaskSchema.parse({ ...candidateTask(description), ...inputs, name: name.trim() || description.trim().slice(0, 60),
        ...(previous ? { id: previous.id, createdAt: previous.createdAt } : {}),
        ...((draftAttachment?.meta ?? previous?.attachmentMeta) ? { attachmentMeta: draftAttachment?.meta ?? previous?.attachmentMeta } : {}),
      });
      if (draftAttachment) { attachments.current.set(task.id, draftAttachment); setAttachmentIds(current => [...new Set([...current, task.id])]); }
      update(current => ({ ...current, tasks: editingId ? current.tasks.map(t => t.id === editingId ? task : t) : [...current.tasks, task], selectedTaskId: task.id }));
      clearDraft(); setMessage(previous ? "등록 정보를 수정했습니다. 변경된 정보로 다시 진단하세요." : "업무를 등록했습니다.");
    } catch { setMessage("등록 정보를 확인하세요. 설명은 필수이며 입력값의 길이와 숫자 범위를 확인해야 합니다."); }
  }
  function confirmCandidates() {
    try {
      if (!candidates.length || state.tasks.length + candidates.length > AX_LIMITS.tasks) throw new Error("등록은 최대 100개까지 가능합니다.");
      const added = candidates.map(candidateTask);
      update(current => ({ ...current, tasks: [...current.tasks, ...added], selectedTaskId: added[0].id }));
      setCandidates([]); setBatchText(""); setMessage(`${added.length}개 업무를 등록했습니다.`);
    } catch (error) { setMessage((error as Error).message); }
  }
  async function attach(file: File, taskId?: string) {
    if (activeRun.current) return;
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
    let revised = task.description;
    if (withAnswers) {
      const rows = (task.diagnosis?.followUpQuestions ?? []).flatMap((q, i) => answers[task.id]?.[i]?.trim() ? [`${q}: ${answers[task.id][i].trim()}`] : []);
      if (!rows.length) { setMessage("추가 질문에 답변을 입력하세요."); return; }
      revised += `\n추가 확인:\n${rows.join("\n")}`;
      if (revised.length > AX_LIMITS.description) { setMessage("답변을 포함한 설명은 3,000자 이하여야 합니다. 등록 정보를 수정해 정리하세요."); return; }
    }
    activeRun.current = true; activeAi.current = true; setBusy(task.id); setMessage("");
    try {
      const output = await diagnoseAx({ kind: "ax-diagnosis", name: task.name, description: revised, details: taskDetails(task), ...(attachment ? { attachmentSummary: attachment.summary } : {}) });
      if (!alive.current) return;
      const diagnosis: AxDiagnosis = { ...output, sourceNote: attachment ? "첨부 파일 요약 기반 진단 · 첨부 파일이 사용됨 — 재분석 시 재첨부 필요" : "사용자 등록 정보 기반 진단" };
      patchTask(task.id, { description: revised, diagnosis, status: taskStatus(diagnosis) });
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
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("AX 데이터를 내보냈습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "AX 데이터를 내보내지 못했습니다."); }
  }
  async function acceptImport(file: File) {
    try {
      if (file.size > AX_LIMITS.transferBytes) throw new Error("가져오기 파일은 8MB 이하여야 합니다.");
      const imported = importAxState(await file.text());
      if (state.tasks.length) setConfirmation({ kind: "import", state: imported });
      else { const saved = await replace(imported); attachments.current.clear(); setAttachmentIds([]); clearDraft(); setMessage(saved ? "AX 데이터를 가져왔습니다." : "AX 데이터를 가져왔으나 브라우저 저장에 실패했습니다. 내보내기로 보관하세요."); }
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
      attachments.current.clear(); setAttachmentIds([]); clearDraft(); setCandidates([]); setBatchText(""); setAnswers({});
      setMessage(saved ? action.kind === "reset" ? "AX 데이터를 초기화했습니다." : "AX 데이터를 가져왔습니다." : "화면 데이터를 변경했으나 브라우저 저장에 실패했습니다. 새로고침 시 이전 데이터가 복원될 수 있습니다.");
    }
  }
  const diagnosedCount = state.tasks.filter(t => !!t.diagnosis).length;
  const knownMinutes = state.tasks.map(monthlyMinutes).filter((m): m is number => m !== null);
  function totals() {
    return state.tasks.length ? <dl className="ax-totals"><div><dt>등록 업무</dt><dd>{state.tasks.length}개</dd></div><div><dt>진단 완료</dt><dd>{diagnosedCount}개</dd></div>
      {knownMinutes.length ? <div><dt>월 투입시간 합 · 입력 {knownMinutes.length}개</dt><dd>{(knownMinutes.reduce((sum, m) => sum + m, 0) / 60).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}시간</dd></div> : null}
      {diagnosedCount ? <div><dt>우선 검토 후보</dt><dd>{ranked.filter(r => matrixPosition(r.task.diagnosis).region === "quick").length}개</dd></div> : null}</dl> : null;
  }
  function taskPicker() {
    return <section className="ax-task-list" aria-label="등록 업무 목록"><h3>업무 목록</h3>{!state.tasks.length ? <AxEmptyState title="등록된 업무가 없습니다" description="왼쪽에서 첫 업무를 등록해주세요." /> : <><p className="ax-muted">등록한 업무를 선택해 진단을 진행합니다.</p><ul>{state.tasks.map(task => <li key={task.id}><Button type="button" variant={selected?.id === task.id ? "secondary" : "ghost"} aria-pressed={selected?.id === task.id} onClick={() => select(task.id)} disabled={!!busy}><span>{task.name}</span><Badge variant="outline">{STATUS[task.status]}</Badge></Button>{state.step === 1 ? <Button type="button" variant="ghost" aria-label={`${task.name} 삭제`} disabled={!!busy} onClick={() => setConfirmation({ kind: "delete", id: task.id })}>삭제</Button> : null}</li>)}</ul></>}</section>;
  }
  function detach(task: AxTask) {
    attachments.current.delete(task.id); setAttachmentIds(current => current.filter(id => id !== task.id));
    patchTask(task.id, { attachmentMeta: undefined, diagnosis: undefined, status: "registered" });
    setMessage("첨부를 해제했습니다. 등록 정보로 다시 진단할 수 있습니다.");
  }
  function attachmentStatus(task: AxTask) {
    return <div className="ax-attachment">{task.attachmentMeta ? <p>{task.attachmentMeta.name} · {attachmentIds.includes(task.id) ? "세션 요약 준비됨" : "첨부 파일이 사용됨 — 재분석 시 재첨부 필요"} <Button type="button" variant="ghost" disabled={!!busy} onClick={() => detach(task)}>첨부 해제</Button></p> : null}
      <AxAttachmentInput label={task.attachmentMeta ? "첨부 파일 다시 선택" : "참고 파일"} disabled={!!busy} onSelect={file => void attach(file, task.id)} /></div>;
  }
  return <section className="ax-view" aria-label="업무 자동화 진단" aria-busy={!!busy}>
    <div className="ax-data-actions">
      <Menu><MenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="AX 데이터 작업" disabled={!ready || !!busy} />}><MoreHorizontal aria-hidden="true" /></MenuTrigger><MenuPopup align="end">
        <MenuItem onClick={download}><Upload aria-hidden="true" />AX 데이터 내보내기</MenuItem>
        <MenuItem onClick={() => importInput.current?.click()}><Download aria-hidden="true" />AX 데이터 가져오기</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => setConfirmation({ kind: "reset" })}><Trash2 aria-hidden="true" />AX 데이터 초기화</MenuItem>
      </MenuPopup></Menu>
      <input ref={importInput} type="file" hidden accept=".json,application/json" aria-label="AX 데이터 가져오기 파일" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void acceptImport(file); }} />
    </div>
    {saveStatus === "저장 실패" ? <p role="status" className="ax-notice">자동 저장에 실패했습니다. 필요하면 AX 데이터를 내보내 백업해주세요.</p> : null}
    {loadNotice ? <p role="status" className="ax-notice">{loadNotice}</p> : null}
    {message ? <p role="status" className="ax-notice">{message}</p> : null}
    {!ready ? <p role="status">AX 데이터를 불러오는 중…</p> : <Tabs value={String(state.step)} onValueChange={value => changeStep(Number(value))}>
      <TabsList className="ax-steps" aria-label="진단 단계" variant="underline">{STEPS.map((s, i) => <TabsTab key={s} value={String(i + 1)} disabled={!!busy}><span className="ax-step-number">{String(i + 1).padStart(2, "0")}</span><span className="ax-step-label">{s}</span></TabsTab>)}</TabsList>
      <TabsPanel value="1">
        {totals()}
        <div className="ax-register-layout"><div>
          <form className="ax-form" onSubmit={register}><h2>{editingId ? "등록 정보 수정" : "업무 등록"}</h2>
            <div className="ax-field"><label className="ax-field">업무명<Input type="text" value={name} maxLength={AX_LIMITS.name} onChange={e => setName(e.target.value)} disabled={!!busy} aria-describedby={nameHelpId} /></label><small id={nameHelpId}>비워두면 업무 설명을 기준으로 자동 생성됩니다.</small></div>
            <label className="ax-field"><span className="ax-required-label">업무 설명</span><Textarea value={description} required maxLength={AX_LIMITS.description} onChange={e => setDescription(e.target.value)} disabled={!!busy} placeholder="어떤 업무를 반복하고 있으며, 어떤 자료를 받아 어떤 결과를 만드는지 설명해주세요." rows={5} /></label>
            <Accordion><AccordionItem value="details"><AccordionTrigger>추가 정보</AccordionTrigger><AccordionPanel><div className="ax-form-grid">{DETAILS.map(({ key, label, numeric }) => <label className="ax-field" key={key}>{label}<Input type={numeric ? "number" : "text"} min={numeric ? key === "people" ? 1 : 0 : undefined} max={numeric ? 100000 : undefined} step={key === "people" ? 1 : "any"} maxLength={numeric ? undefined : AX_LIMITS.detail} value={details[key] ?? ""} onChange={e => setDetails(current => ({ ...current, [key]: e.target.value }))} disabled={!!busy} /></label>)}</div></AccordionPanel></AccordionItem></Accordion>
            <AxAttachmentInput label="참고 파일" disabled={!!busy} onSelect={file => void attach(file)} />
            {draftAttachment ? <p className="ax-muted">{draftAttachment.meta.name} · 세션 요약 준비됨 <Button type="button" variant="ghost" onClick={() => setDraftAttachment(null)} disabled={!!busy}>첨부 취소</Button></p> : null}
            <div className="ax-actions"><Button type="submit" disabled={!!busy || !description.trim()}>{editingId ? "수정 저장" : "업무 등록"}</Button>{editingId ? <Button type="button" variant="ghost" onClick={clearDraft}>수정 취소</Button> : null}</div>
          </form>
          <Accordion><AccordionItem value="batch"><AccordionTrigger>여러 업무 일괄 추가</AccordionTrigger><AccordionPanel>
            <label className="ax-field">업무 목록 입력<Textarea value={batchText} maxLength={30000} onChange={e => setBatchText(e.target.value)} rows={5} placeholder="줄마다 업무를 입력하거나 번호·bullet로 구분하세요" /></label>
            <Button type="button" variant="outline" disabled={!!busy || !batchText.trim()} onClick={() => { const parsed = splitTasks(batchText); if (parsed.length + state.tasks.length > AX_LIMITS.tasks) setMessage("후보와 등록 업무의 합은 100개 이하여야 합니다."); else setCandidates(parsed); }}>후보 만들기</Button>
            {!!candidates.length && <div className="ax-candidates"><h3>등록 후보 · {candidates.length}개</h3>{candidates.map((candidate, i) => <div key={i} className="ax-candidate"><label className="ax-field">후보 {i + 1}<Textarea rows={2} aria-label={`후보 ${i + 1}`} value={candidate} maxLength={AX_LIMITS.description} onChange={e => setCandidates(current => current.map((c, j) => j === i ? e.target.value : c))} /></label><div className="ax-actions">
              <Button type="button" variant="ghost" onClick={() => { const split = splitTasks(candidate); if (split.length < 2) setMessage("분리할 위치에 줄바꿈 또는 번호를 넣으세요."); else setCandidates(current => current.flatMap((c, j) => j === i ? split : [c])); }}>분리</Button>
              {i < candidates.length - 1 ? <Button type="button" variant="ghost" onClick={() => setCandidates(current => current.flatMap((c, j) => j === i ? [`${c}\n${current[j + 1]}`] : j === i + 1 ? [] : [c]))}>다음과 합치기</Button> : null}
              <Button type="button" variant="ghost" onClick={() => setCandidates(current => current.filter((_, j) => i !== j))}>삭제</Button></div></div>)}<Button type="button" disabled={!!busy} onClick={confirmCandidates}>후보 확정 · 업무 등록</Button></div>}
          </AccordionPanel></AccordionItem></Accordion>
        </div>{taskPicker()}</div>
        {selected ? <div className="ax-actions"><Button type="button" variant="outline" onClick={() => editTask(selected)} disabled={!!busy}>등록 정보 수정</Button><Button type="button" onClick={() => changeStep(2)} disabled={!!busy}>선택 업무 진단으로</Button></div> : null}
      </TabsPanel>
      <TabsPanel value="2">
        {taskPicker()}
        {!selected ? <AxEmptyState title="진단할 업무가 없습니다" description="업무를 등록한 뒤 진단을 시작하세요." /> : <div className="ax-detail"><div className="ax-section-heading"><h2>{selected.name}</h2><Badge variant="outline">{STATUS[selected.status]}</Badge></div><p>{selected.description}</p>
          {attachmentStatus(selected)}
          <div className="ax-actions"><Button type="button" disabled={!!busy} onClick={() => void diagnose(selected)}>{busy === selected.id ? "진단 중…" : selected.diagnosis ? "업무 다시 진단" : "업무 진단 실행"}</Button><Button type="button" variant="outline" disabled={!!busy} onClick={() => editTask(selected)}>등록 정보 수정</Button>{busy && busy !== "attachment" ? <Button type="button" variant="ghost" onClick={interruptServerAi}>AI 작업 중지</Button> : null}</div>
          {selected.diagnosis ? <><section className="ax-section"><div className="ax-section-heading"><h3>진단 결과</h3><Badge variant={selected.diagnosis.informationSufficiency === "sufficient" ? "success" : "warning"}>{SUFFICIENCY[selected.diagnosis.informationSufficiency]}</Badge></div><p className="ax-muted">{selected.diagnosis.sourceNote}</p><AxSummary task={selected} />
            {selected.diagnosis.followUpQuestions.length ? <div className="ax-questions"><h4>추가 확인 질문</h4>{selected.diagnosis.followUpQuestions.map((q, i) => <label className="ax-field" key={i}>{q}<Textarea rows={2} maxLength={500} disabled={!!busy} value={answers[selected.id]?.[i] ?? ""} onChange={e => setAnswers(current => { const values = [...(current[selected.id] ?? [])]; values[i] = e.target.value; return { ...current, [selected.id]: values }; })} /></label>)}<Button type="button" variant="outline" disabled={!!busy} onClick={() => void diagnose(selected, true)}>답변 반영 재진단</Button></div> : null}
          </section><section className="ax-section"><h3>진단 항목</h3><p className="ax-muted">필요하면 AI 평가값을 조정할 수 있습니다. 변경한 값은 자동화 수준과 우선순위에 바로 반영됩니다.</p><div className="ax-factors">{selected.diagnosis.factors.map(f => <div className="ax-factor" key={f.key}><div><h4>{FACTOR_LABELS[f.key]} · AI {f.aiValue}점</h4><p>{f.rationale}</p><small>{factorScale(f.key)}</small></div><label className="ax-field">{FACTOR_LABELS[f.key]} 보정<Input type="number" min={1} max={5} step={1} value={f.finalValue ?? ""} placeholder="AI" disabled={!!busy} onChange={e => adjust(selected, f.key, e.target.value)} /></label></div>)}</div></section><AxProcess diagnosis={selected.diagnosis} /></> : null}
        </div>}
      </TabsPanel>
      <TabsPanel value="3"><h2>자동화 매트릭스</h2><p className="ax-muted">자동화 가치와 기술 실현 가능성을 기준으로 업무를 비교합니다.</p>
        {!ranked.length ? <AxEmptyState title="비교할 진단 결과가 없습니다" description="진단이 완료된 업무가 자동화 매트릭스에 표시됩니다." /> : <>
          <AxMatrix tasks={ranked.map(r => r.task)} selectedId={selected?.id} onSelect={select} />
          <div className="ax-matrix-list" aria-label="매트릭스 업무 목록">{ranked.map(({ task }) => { const a = axes(task.diagnosis), m = matrixPosition(task.diagnosis); return <Button type="button" key={task.id} variant={selected?.id === task.id ? "secondary" : "ghost"} onClick={() => select(task.id)} aria-pressed={selected?.id === task.id}><span>{task.name}</span><span>{m.label} · 가치 {a.value} / 실현 {a.feasibility}</span></Button>; })}</div>
          {selected?.diagnosis ? <section className="ax-section"><h3>{selected.name} · {matrixPosition(selected.diagnosis).label}</h3><AxSummary task={selected} /><Button type="button" variant="outline" onClick={() => changeStep(2)}>점수·근거 확인</Button></section> : null}
        </>}
      </TabsPanel>
      <TabsPanel value="4"><h2>결과·로드맵</h2>{totals()}
        {!ranked.length ? <AxEmptyState title="아직 결과가 없습니다" description="업무 진단이 완료되면 우선순위와 실행 로드맵을 확인할 수 있습니다." /> : <>
          <section className="ax-section"><h3>우선순위</h3><p className="ax-muted">자동화 가치, 기술 실현 가능성, 운영 위험, 사람 판단 의존도를 종합해 우선순위를 계산합니다.</p><div className="ax-table-wrap"><table aria-label="업무 우선순위"><thead><tr><th>순위</th><th>업무</th><th>자동화 수준</th><th className="ax-muted">점수</th><th>선정 이유</th></tr></thead><tbody>{ranked.map((r, i) => { const l = automationLevel(r.task.diagnosis); return <tr key={r.task.id}><td>{i + 1}</td><td><Button type="button" variant="ghost" aria-pressed={selected?.id === r.task.id} onClick={() => select(r.task.id)} disabled={!!busy}>{r.task.name}</Button></td><td>{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</td><td className="ax-muted">{r.score}</td><td>{r.reason}</td></tr>; })}</tbody></table></div></section>
          {selected?.diagnosis ? <div className="ax-detail"><h2>{selected.name}</h2><p className="ax-muted">{selected.diagnosis.sourceNote}</p><AxSummary task={selected} /><AxRoadmap diagnosis={selected.diagnosis} /><section className="ax-section"><h3>구현 계획</h3><div className="ax-actions"><Button type="button" variant="outline" disabled={!!busy} onClick={() => void generatePlan(selected, "codex")}>{busy === "codex" ? "Codex 계획 생성 중…" : "Codex용 구현 계획 생성"}</Button><Button type="button" variant="outline" disabled={!!busy} onClick={() => void generatePlan(selected, "claude")}>{busy === "claude" ? "Claude 계획 생성 중…" : "Claude Code용 구현 계획 생성"}</Button></div></section>{selected.diagnosis.planCodex ? <AxPlanReport plan={selected.diagnosis.planCodex} title="Codex용 구현 계획" /> : null}{selected.diagnosis.planClaude ? <AxPlanReport plan={selected.diagnosis.planClaude} title="Claude Code용 구현 계획" /> : null}</div> : <p>우선순위 표에서 업무를 선택해 상세 결과를 확인하세요.</p>}
        </>}
      </TabsPanel>
    </Tabs>}
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogPopup><AlertDialogHeader><AlertDialogTitle>{confirmation?.kind === "import" ? "AX 데이터를 덮어쓸까요?" : confirmation?.kind === "delete" ? "업무를 삭제할까요?" : "AX 데이터를 초기화할까요?"}</AlertDialogTitle><AlertDialogDescription>{confirmation?.kind === "import" ? "검증된 가져오기 데이터로 현재 AX 업무·진단·계획을 교체합니다." : confirmation?.kind === "delete" ? "선택한 업무와 진단·계획을 삭제합니다." : "현재 AX 업무·진단·계획만 삭제합니다. 다른 작업 공간은 유지됩니다."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogClose render={<Button type="button" variant="ghost" />}>취소</AlertDialogClose><Button type="button" variant="destructive" onClick={() => void confirm()}>{confirmation?.kind === "import" ? "덮어쓰기" : confirmation?.kind === "delete" ? "삭제" : "초기화"}</Button></AlertDialogFooter></AlertDialogPopup></AlertDialog>
  </section>;
}
function AxEmptyState({ title, description }: { title: string; description: string }) {
  return <div className="ax-empty"><h3>{title}</h3><p className="ax-muted">{description}</p></div>;
}
function AxAttachmentInput({ label, disabled, onSelect }: { label: string; disabled: boolean; onSelect: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const labelId = useId();
  return <div className="ax-field ax-file-input">
    <span id={labelId}>{label}</span>
    <input ref={input} type="file" hidden accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label={label} disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) onSelect(file);
    }} />
    <Button type="button" variant="outline" disabled={disabled} aria-describedby={labelId} onClick={() => input.current?.click()}>파일 선택</Button>
  </div>;
}
function AxMatrix({ tasks, selectedId, onSelect }: { tasks: (AxTask & { diagnosis: AxDiagnosis })[]; selectedId?: string; onSelect: (id: string) => void }) {
  const max = Math.max(0, ...tasks.map(t => monthlyMinutes(t) ?? 0));
  return <div className="ax-matrix-desktop"><div className="ax-matrix" aria-label="자동화 매트릭스 산점도">
    <div className="ax-region ax-region-strategic">전략 과제</div><div className="ax-region ax-region-quick">빠른 실행 후보</div><div className="ax-region ax-region-hold">수동 유지·보류</div><div className="ax-region ax-region-maybe">검토 후보</div>
    {[1, 2, 3, 4, 5].map(v => <span key={v} className="ax-y-tick" style={{ bottom: `${(v - 1) / 4 * 100}%` }}>{v}</span>)}
    {[1, 2, 3, 4, 5].map(v => <span key={v} className="ax-x-tick" style={{ left: `${(v - 1) / 4 * 100}%` }}>{v}</span>)}
    {tasks.map((task, i) => { const m = matrixPosition(task.diagnosis); const diameter = Math.sqrt(bubbleArea(task, max) / Math.PI) * 2; return <button type="button" key={task.id} className={`ax-bubble${m.region === "hold" ? " is-hold" : ""}`} style={{ left: `${m.x}%`, bottom: `${m.y}%`, width: Math.max(24, diameter), height: Math.max(24, diameter), zIndex: selectedId === task.id ? 3 : 2 }} aria-label={`${task.name} · ${m.label}`} aria-pressed={selectedId === task.id} title={`${task.name} · ${m.label}`} onClick={() => onSelect(task.id)}><span className="ax-bubble-dot" style={{ width: diameter, height: diameter }} /><span className="ax-bubble-number">{i + 1}</span></button>; })}
    <span className="ax-y-label">자동화 가치</span><span className="ax-x-label">기술 실현 가능성</span>
  </div><p className="ax-muted">원의 번호는 아래 목록 순서입니다. 원 면적은 입력된 월 투입시간에 비례하며, 시간 정보가 없는 업무는 동일한 크기로 표시합니다. 보류 업무는 테두리로 구분합니다.</p></div>;
}
