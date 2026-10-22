"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { MoreHorizontal, Upload, Download, Trash2, Pencil, ClipboardList, CircleCheck, Zap, Clock3, Stethoscope, LayoutGrid, Map as MapIcon, ArrowLeft, ArrowRight, Paperclip, FileText, X, Repeat, CalendarCheck, Database, Plug, UserCheck, AlertTriangle, RotateCcw, ListChecks, CircleHelp, SlidersHorizontal, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem, MenuSeparator } from "@/components/ui/menu";
import { AlertDialog, AlertDialogPopup, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogClose } from "@/components/ui/alert-dialog";
import { useAxState } from "@/client/use-ax-state";
import { runInWorker } from "@/client/document-client";
import { diagnoseAx, planAx, interruptServerAi, aiFailureDetail } from "@/client/server-ai-client";
import { AX_LIMITS, FACTOR_LABELS, axTaskSchema, axTaskV2Schema, confirmedAxDiagnosis } from "@/lib/ax/schema";
import { axes, automationLevel, bubbleArea, executionGate, executionProfile, GATE_LABELS, planAllowed, priorityHeading, factorEffectiveValue, factorHasAdjustment, factorScale, matrixPosition, monthlyMinutes, nextAction, priority, splitGatePrerequisites, taskStatus, taskDisplayStatus } from "@/lib/ax/policy";
import { candidateTask, taskDetails, followUpDescription, legacyDetailValues, validateAttachmentPreflight, isRegistrationUnchanged } from "@/lib/ax/registration";
import { MAX_TASK_ATTACHMENTS, attachmentPatch, buildAttachmentSummary, combineAttachmentSummaries, taskAttachments } from "@/lib/ax/attachments";
import type { AxAttachmentMeta } from "@/lib/ax/types";
import { exportAxState, importAxState } from "@/lib/ax/transfer";
import { emptyAxState, type AxStateV2, type AxTask, type AxDiagnosis, type AxDetails, type FactorKey } from "@/lib/ax/types";
import { extractReviewableItems, extractPlanReviewableItems, reconcileReviews, validateReviewForConfirm, type ReviewableItem } from "@/lib/ax/hitl";
import { AxProcess, AxResultSummary, AxExecutionTimeline, AxPlanSection, AxScoreCards, AxCheckIcon, diagnosisSummarySentences, diagnosisCheckItems, visibleDiagnosisCheckItems, matrixRationaleBullets } from "./AxReport";
import { AxScoreEvidence } from "./AxScoreEvidence";
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
const DETAILS: { key: keyof AxDetails; label: string; placeholder: string; numeric?: boolean }[] = [
  { key: "cycle", label: "수행 주기", placeholder: "예: 매주 월요일, 매월 말일, 필요 시" }, { key: "minutesPerRun", label: "1회 소요 시간(분)", placeholder: "예: 30", numeric: true },
  { key: "runsPerMonth", label: "월 수행 횟수", placeholder: "예: 8", numeric: true },
  { key: "systems", label: "사용 시스템", placeholder: "예: Excel, ERP, 사내 시스템" }, { key: "inputs", label: "입력 자료", placeholder: "예: 정산 Excel, 청구서, 시스템 조회 데이터" }, { key: "outputs", label: "산출물", placeholder: "예: 월간 정산표, 검토 결과, 보고서" },
  { key: "humanSteps", label: "담당자 판단·승인 단계", placeholder: "예: 예외 건 검토, 금액 확인, 최종 승인" },
];
type SessionAttachment = { meta: AxAttachmentMeta; summary: string };
/** 등록 폼 초안 항목: 세션 요약이 있으면 준비됨, 메타만 복원된 항목은 summary가 null(재첨부 필요). */
type DraftAttachment = { meta: AxAttachmentMeta; summary: string | null };
type Confirmation = { kind: "import"; state: AxStateV2 } | { kind: "reset" } | { kind: "delete"; id: string };
type RankedTask = { task: AxTask & { diagnosis: AxDiagnosis }; rank: number };

/** Header counts use the same executionGate as the badges, so a conditional task is never counted as "ready". */
function diagnosisCounts(tasks: AxTask[]) {
  const results = tasks.filter((task): task is AxTask & { diagnosis: AxDiagnosis } => !!task.diagnosis);
  const gates = results.map(task => executionGate(task.diagnosis));
  return {
    results: results.length,
    ready: gates.filter(gate => gate === "ready").length,
    conditional: gates.filter(gate => gate === "conditional").length,
    blocked: gates.filter(gate => gate === "blocked").length,
    questions: results.filter(task => task.diagnosis.informationSufficiency === "needs-check").length,
  };
}
const MATRIX_DETAIL_ID = "ax-matrix-detail";

export function AxDiagnosisView() {
  const { state, update, getState, replace, ready, saveStatus, loadNotice, externalChange, storageProtection } = useAxState();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const activeRun = useRef(false), activeAi = useRef(false), alive = useRef(true);
  // 비동기 요청 추적: 오래된 AI 응답이 최신 상태를 덮어쓰지 않도록 보호
  const requestSeq = useRef(0);
  const taskRequestSeq = useRef(new Map<string, number>());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState<Partial<Record<keyof AxDetails, string>>>({});
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const attachments = useRef(new Map<string, SessionAttachment[]>());
  // 파일별 세션 요약 준비 여부 (렌더용): taskId → 요약이 준비된 파일 지문 목록. 실제 요약 본문은 attachments ref가 보유한다.
  const [sessionReady, setSessionReady] = useState<Record<string, string[]>>({});
  function markSessionReady(taskId: string, fingerprints: string[]) {
    setSessionReady(current => fingerprints.length ? { ...current, [taskId]: fingerprints } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== taskId)));
  }
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const importInput = useRef<HTMLInputElement>(null);
  const nameHelpId = useId();
  const [showScores, setShowScores] = useState(true);
  const [showMatrixHelp, setShowMatrixHelp] = useState(false);
  const ranked = priority(state.tasks).map((row, index) => ({ ...row, rank: index + 1 }));
  // 매트릭스 목록: 기존 우선순위순 고정 표시 (원본 데이터·계산 변경 없음)
  const matrixListed = ranked;
  const counts = diagnosisCounts(state.tasks);
  const matrixStatus = <p className="ax-muted ax-matrix-counts">등록 {state.tasks.length}개 · 진단 완료 {counts.results}개 (진행 가능 {counts.ready}개 · 확인 후 진행 {counts.conditional}개 · 진행 보류 {counts.blocked}개) · 추가 질문 필요 {counts.questions}개{state.tasks.length > counts.results ? ` · 미진단 ${state.tasks.length - counts.results}개 제외` : ""}</p>;
  const gateOrder = { ready: 0, conditional: 1, blocked: 2 };
  const profiles = ranked.map(row => ({ row, profile: executionProfile(row.task.diagnosis) }));
  const displayed = [...profiles].sort((a, b) => gateOrder[a.profile.gate] - gateOrder[b.profile.gate]).map(({ row }) => row);
  const readyCandidates = profiles.filter(({ profile }) => profile.readyExecutionCandidate);
  const conditional = profiles.filter(({ profile }) => profile.gate === "conditional");
  const review = profiles.filter(({ profile }) => profile.gate !== "blocked");
  const overviewProfiles = (readyCandidates.length ? readyCandidates : conditional.length ? conditional : review.length ? review : profiles).slice(0, 3);
  const overviewRows = overviewProfiles.map(({ row }) => row);
  const overviewHeading = priorityHeading(overviewProfiles.map(({ profile }) => profile));
  const overviewIsTop = readyCandidates.length > 0;
  const currentSelection = state.tasks.find(task => task.id === state.selectedTaskId);
  const selected = state.step >= 3 ? currentSelection?.diagnosis ? currentSelection : displayed[0]?.task : currentSelection ?? state.tasks[0];
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (ready && state.selectedTaskId !== selectedId) update(current => ({ ...current, selectedTaskId: selectedId }));
  }, [ready, state.selectedTaskId, selectedId, update]);
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

  /** HITL 검토 저장: v2 reviews 필드에 저장 (중복 방지, ID 유지)
   * - confirmed 저장 전 현재 원본 기준으로 전체 일치 검증 (키·유형·출처·해시·중복)
   * - 검증 실패 시 확정 저장을 차단하고 사유를 반환 (조용히 pending으로 변경하지 않음)
   * - 기존 검토 이력은 보존 */
  function saveHitlReview(taskId: string, reviewInput: Omit<import("@/lib/ax/types").HitlReview, "id" | "reviewedAt" | "updatedAt"> & { id?: string }): { saved: boolean; reason?: string } {
    const now = new Date().toISOString();
    // 검증과 변경을 동일한 최신 상태 경계에서 처리 (원자성 보장)
    const result: { applied: boolean; reason?: string } = { applied: false };
    update(current => {
      // confirmed 확정 전 검증: 최신 상태 기준으로 원본 확인
      if (reviewInput.status === "confirmed") {
        const task = current.tasks.find(t => t.id === taskId) as import("@/lib/ax/types").AxTaskV2 | undefined;
        const validation = validateReviewForConfirm(task, reviewInput.target);
        if (!validation.valid) {
          result.reason = validation.reason;
          return current; // 검증 실패: 변경 없음
        }
      }
      result.applied = true;
      return {
        ...current,
        tasks: current.tasks.map(t => {
          if (t.id !== taskId) return t;
          const taskV2 = t as import("@/lib/ax/types").AxTaskV2;
          const existing = taskV2.reviews?.find(r => r.id === reviewInput.id)
            ?? taskV2.reviews?.find(r => r.target.key === reviewInput.target.key);
          const review: import("@/lib/ax/types").HitlReview = {
            ...reviewInput,
            id: existing?.id ?? reviewInput.id ?? `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            reviewedAt: existing?.reviewedAt ?? now,
            updatedAt: now,
          };
          const reviews = (taskV2.reviews ?? []).filter(r => r.id !== review.id && r.target.key !== review.target.key);
          return { ...t, reviews: [...reviews, review], updatedAt: now } as import("@/lib/ax/types").AxTaskV2;
        }),
      };
    });
    if (!result.applied) {
      if (result.reason) setMessage(`검토를 확정할 수 없습니다. ${result.reason}`);
      return { saved: false, reason: result.reason };
    }
    // applied=true: 로컬 반영 완료 (IndexedDB 영구 저장은 비동기로 진행됨)
    return { saved: true };
  }
  // 단계 전환 후 새 단계의 최상단으로 스크롤 (이전 화면의 스크롤 위치가 유지되지 않도록)
  // 실제 스크롤 주체는 document(window) — #workspace-content(.workspace)는 스크롤 컨테이너가 아니므로
  // 해당 요소에만 scrollTop을 설정하면 동작하지 않음 (PR #161의 잔여 결함)
  // useLayoutEffect: DOM 반영 직후·페인트 전에 실행해 스크롤 잔상 방지
  const stepRef = useRef(state.step);
  // Firefox의 자동 스크롤 복원이 React 스크롤 초기화와 경합하는 것을 방지
  // (history.scrollRestoration='manual'로 브라우저 자동 복원 비활성화)
  useEffect(() => {
    if (typeof history !== "undefined" && "scrollRestoration" in history) {
      const prev = history.scrollRestoration;
      history.scrollRestoration = "manual";
      return () => { history.scrollRestoration = prev; };
    }
    return undefined;
  }, []);
  useLayoutEffect(() => {
    if (stepRef.current !== state.step) {
      stepRef.current = state.step;
      const doScroll = () => {
        const container = document.getElementById("workspace-content");
        if (container && container.scrollHeight > container.clientHeight) container.scrollTop = 0;
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
      };
      doScroll();
      // Firefox 등에서 페인트 후 스크롤 위치가 복원되는 경우에 대비해 다음 프레임에서도 적용
      // 다중 RAF + setTimeout으로 브라우저의 스크롤 복원 이후 시점까지 보장
      let raf2 = 0;
      let raf3 = 0;
      let raf4 = 0;
      let timer = 0;
      const raf = requestAnimationFrame(() => {
        if (window.scrollY !== 0) doScroll();
        raf2 = requestAnimationFrame(() => {
          if (window.scrollY !== 0) doScroll();
          raf3 = requestAnimationFrame(() => {
            if (window.scrollY !== 0) doScroll();
            raf4 = requestAnimationFrame(() => {
              if (window.scrollY !== 0) doScroll();
            });
          });
        });
      });
      // 최종 안전망: RAF 체인 이후에도 복원되는 경우 대비 (한 번만)
      timer = window.setTimeout(() => {
        if (window.scrollY !== 0) doScroll();
      }, 150);
      return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); cancelAnimationFrame(raf3); cancelAnimationFrame(raf4); clearTimeout(timer); };
    }
    return undefined;
  }, [state.step]);
  function clearDraft() { setName(""); setDescription(""); setDetails({}); setDraftAttachments([]); setEditingId(null); }
  function editTask(task: AxTask) {
    select(task.id);
    setEditingId(task.id); setName(task.name); setDescription(task.description);
    setDetails(Object.fromEntries(Object.entries(taskDetails(task)).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
    // 저장된 메타데이터를 초안으로 복원한다. 세션 요약이 있는 파일은 준비됨으로,
    // 새로고침 등으로 원본이 없는 파일은 재첨부 필요 상태로 표시한다.
    const session = attachments.current.get(task.id) ?? [];
    setDraftAttachments(taskAttachments(task).map(meta => {
      const found = session.find(entry => entry.meta.fingerprint === meta.fingerprint);
      return { meta, summary: found ? found.summary : null };
    }));
    changeStep(1);
  }
  /** 업무의 세션 요약이 모두 준비됐으면 통합 요약을, 하나라도 빠졌으면 undefined를 반환한다. */
  function sessionSummary(taskId: string, metas: AxAttachmentMeta[]): string | undefined {
    if (!metas.length) return undefined;
    const session = attachments.current.get(taskId) ?? [];
    const byFingerprint = new Map(session.map(entry => [entry.meta.fingerprint, entry]));
    if (!metas.every(meta => byFingerprint.has(meta.fingerprint))) return undefined;
    return combineAttachmentSummaries(metas.map(meta => ({ name: meta.name, summary: byFingerprint.get(meta.fingerprint)!.summary })));
  }
  function register(event: FormEvent) {
    event.preventDefault();
    try {
      if (!editingId && state.tasks.length >= AX_LIMITS.tasks) throw new Error("등록은 최대 100개까지 가능합니다.");
      const inputs = Object.fromEntries(DETAILS.flatMap(({ key, numeric }) => {
        const value = details[key]?.trim(); return value ? [[key, numeric ? Number(value) : value]] : [];
      }));
      const previous = state.tasks.find(t => t.id === editingId);
      const task = axTaskV2Schema.parse({ ...candidateTask(description), ...(previous ? legacyDetailValues(previous) : {}), ...inputs, name: name.trim() || description.trim().slice(0, 60),
        ...(previous ? { id: previous.id, createdAt: previous.createdAt } : {}),
        ...attachmentPatch(draftAttachments.map(entry => entry.meta)),
        // HITL: 기존 검토 기록 보존 (v1 스키마 사용 시 reviews 필드 손실 방지)
        ...(previous && "reviews" in previous && previous.reviews ? { reviews: previous.reviews } : {}),
      });
      // 세션 요약 동기화: 초안에서 요약이 준비된 파일만 세션에 남긴다.
      // 등록 내용이 그대로여도 폼에서 같은 파일을 다시 첨부해 요약이 복원된 경우를 반영한다.
      const sessionEntries = draftAttachments.filter((entry): entry is SessionAttachment => entry.summary !== null);
      const syncSession = () => {
        if (sessionEntries.length) attachments.current.set(task.id, sessionEntries);
        else attachments.current.delete(task.id);
        markSessionReady(task.id, sessionEntries.map(entry => entry.meta.fingerprint));
      };
      if (previous && isRegistrationUnchanged(previous, task)) {
        syncSession(); clearDraft(); setMessage("변경된 내용이 없습니다."); return;
      }
      syncSession();
      update(current => ({ ...current, tasks: editingId ? current.tasks.map(t => t.id === editingId ? task : t) : [...current.tasks, task], selectedTaskId: task.id }));
      clearDraft(); setMessage(previous ? "등록 정보를 수정했습니다. 변경된 정보로 다시 진단하세요." : "업무를 등록했습니다.");
    } catch { setMessage("등록 정보를 확인하세요. 설명은 필수이며 입력값의 길이와 숫자 범위를 확인해야 합니다."); }
  }
  /** 파일 1개를 워커로 파싱·분석해 개별 요약을 만든다. 실패하면 예외를 던지고 이미 처리된 다른 파일에는 영향을 주지 않는다. */
  async function summarizeFile(file: File, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const fileId = `ax-${crypto.randomUUID()}`;
    try {
      const parsed = await runInWorker({ kind: "parse", fileId, fileName: file.name, bytes }, [bytes.buffer]);
      const [analyzed] = await runInWorker({ kind: "analyze", fileIds: [fileId] });
      return buildAttachmentSummary(parsed.kind, analyzed.analysis.structure, analyzed.topics);
    } finally { await runInWorker({ kind: "forget", fileIds: [fileId] }).catch(() => undefined); }
  }
  async function fingerprintOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  }
  /**
   * 여러 파일을 한 번에 첨부한다. 파일별로 검증·분석하며 일부가 실패해도 성공한 파일은 유지한다.
   * - 중복 판정은 파일명이 아니라 내용 지문(fingerprint) 기준이다.
   * - taskId가 있으면 진단 화면의 재첨부 흐름이다: 지문이 일치하면 세션 요약만 복원하고,
   *   이름이 같은 미복원 파일은 교체로, 그 외 새 파일은 추가로 반영한다. 메타데이터가 실제로
   *   바뀐 경우에만 기존 진단을 무효화한다 (동일 파일 재선택만으로 초기화하지 않음).
   */
  async function attachFiles(files: File[], taskId?: string) {
    if (activeRun.current || !files.length) return;
    activeRun.current = true; setBusy("attachment"); setMessage("");
    const failures: string[] = [];
    let added = 0, restored = 0, duplicates = 0;
    try {
      const task = taskId ? getState().tasks.find(t => t.id === taskId) : undefined;
      if (taskId && !task) return;
      let metas: AxAttachmentMeta[] = task ? taskAttachments(task) : draftAttachments.map(entry => entry.meta);
      const session = new Map<string, SessionAttachment>((taskId ? attachments.current.get(taskId) ?? [] : draftAttachments.filter((entry): entry is SessionAttachment => entry.summary !== null)).map(entry => [entry.meta.fingerprint, entry]));
      let metasChanged = false;
      for (const file of files) {
        try { validateAttachmentPreflight(file); } catch (error) { failures.push(error instanceof Error ? error.message : "첨부 파일을 확인하세요."); continue; }
        let fingerprint: string;
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
          fingerprint = await fingerprintOf(bytes);
        } catch { failures.push(`'${file.name}' 파일을 읽지 못했습니다.`); continue; }
        if (session.has(fingerprint)) { duplicates++; continue; }
        const meta: AxAttachmentMeta = { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, fingerprint };
        // 이미 메타데이터가 있는 동일 파일(새로고침 후 재첨부 등)은 목록을 바꾸지 않고 요약만 복원한다.
        const existingMeta = metas.find(m => m.fingerprint === fingerprint);
        // 진단 화면 재첨부: 이름이 같은 미복원 메타데이터는 같은 파일의 교체로 본다.
        const nameSlot = !existingMeta && task ? metas.find(m => m.name === file.name && !session.has(m.fingerprint)) : undefined;
        if (!existingMeta && !nameSlot && metas.length >= MAX_TASK_ATTACHMENTS) { failures.push(`첨부는 업무당 최대 ${MAX_TASK_ATTACHMENTS}개까지 가능합니다. '${file.name}' 파일은 추가하지 않았습니다.`); continue; }
        let summary: string;
        try { summary = await summarizeFile(file, bytes); } catch { failures.push(`'${file.name}' 파일을 읽지 못했습니다. 지원 형식과 파일 상태를 확인하세요.`); continue; }
        if (!alive.current) return;
        if (existingMeta) { session.set(fingerprint, { meta: existingMeta, summary }); restored++; }
        else if (nameSlot) {
          metas = metas.map(m => m.fingerprint === nameSlot.fingerprint ? meta : m);
          session.set(fingerprint, { meta, summary }); metasChanged = true; added++;
        } else {
          metas = [...metas, meta];
          session.set(fingerprint, { meta, summary }); metasChanged = true; added++;
        }
      }
      const orderedSession = metas.flatMap(meta => { const entry = session.get(meta.fingerprint); return entry ? [entry] : []; });
      if (taskId && task) {
        attachments.current.set(taskId, orderedSession);
        markSessionReady(taskId, orderedSession.map(entry => entry.meta.fingerprint));
        if (metasChanged) patchTask(taskId, { ...attachmentPatch(metas), diagnosis: undefined, status: "registered" });
      } else {
        setDraftAttachments(metas.map(meta => { const entry = session.get(meta.fingerprint); return { meta, summary: entry ? entry.summary : null }; }));
      }
      if (!alive.current) return;
      if (added + restored > 0) {
        const notes = [
          ...(duplicates ? [`이미 첨부된 동일한 파일 ${duplicates}개는 중복으로 추가하지 않았습니다.`] : []),
          ...failures,
        ];
        setMessage(`첨부 요약을 준비했습니다. 진단 실행 시 요약만 AI에 전송됩니다.${notes.length ? ` ${notes.join(" ")}` : ""}`);
      } else if (duplicates > 0 && !failures.length) {
        setMessage(`첨부 요약을 준비했습니다. 진단 실행 시 요약만 AI에 전송됩니다. 이미 첨부된 동일한 파일 ${duplicates}개는 중복으로 추가하지 않았습니다.`);
      } else if (failures.length === 1 && files.length === 1) {
        setMessage(failures[0]);
      } else if (failures.length) {
        setMessage(failures.join(" "));
      }
    } finally { activeRun.current = false; if (alive.current) setBusy(null); }
  }
  function removeDraftAttachment(fingerprint: string) {
    setDraftAttachments(current => current.filter(entry => entry.meta.fingerprint !== fingerprint));
  }
  async function diagnose(task: AxTask, withAnswers = false) {
    if (activeRun.current) return;
    const metas = taskAttachments(task);
    const attachmentSummary = sessionSummary(task.id, metas);
    if (metas.length && !attachmentSummary) { setMessage("첨부 파일이 사용됨 — 재분석 시 재첨부 필요"); return; }
    const revised = withAnswers ? followUpDescription(task.description, task.diagnosis?.followUpQuestions ?? [], answers[task.id] ?? []) : task.description;
    if (withAnswers) {
      if (revised === task.description) { setMessage("추가 질문에 답변을 입력하세요."); return; }
      if (revised.length > AX_LIMITS.description) { setMessage("답변을 포함한 설명은 3,000자 이하여야 합니다. 등록 정보를 수정해 정리하세요."); return; }
    }
    activeRun.current = true; activeAi.current = true; setBusy(task.id); setMessage("");
    // 요청 식별자 발급: 응답 도착 시 최신 요청인지 확인
    const mySeq = ++requestSeq.current;
    taskRequestSeq.current.set(task.id, mySeq);
    // 요청 시점의 업무 입력 스냅샷 (응답 유효성 검증용) - 전체 입력 기준
    // withAnswers=true인 경우 revised에는 답변이 포함되므로, 비교 시에도 동일하게 재구성해야 함
    const requestAnswers = withAnswers ? [...(answers[task.id] ?? [])] : [];
    const requestQuestions = withAnswers ? [...(task.diagnosis?.followUpQuestions ?? [])] : [];
    const requestInput = JSON.stringify({
      name: task.name,
      description: revised,
      details: taskDetails(task),
      attachmentSummary: attachmentSummary ?? null,
    });
    try {
      const output = await diagnoseAx({ kind: "ax-diagnosis", name: task.name, description: revised, details: taskDetails(task), ...(attachmentSummary ? { attachmentSummary } : {}) });
      if (!alive.current) return;
      // 오래된 응답 보호: 더 새로운 요청이 시작되었으면 이 응답을 버림
      if (taskRequestSeq.current.get(task.id) !== mySeq) {
        setMessage("최신 상태가 변경되어 이전 진단 결과를 반영하지 않았습니다.");
        return;
      }
      const diagnosis: AxDiagnosis = { ...output, sourceNote: attachmentSummary ? "첨부 파일 요약 기반 진단 · 첨부 파일이 사용됨 — 재분석 시 재첨부 필요" : "사용자 등록 정보 기반 진단" };
      // HITL: 재진단 시 기존 검토와 새 진단 비교 → 변경된 항목 stale 처리
      // 원자적 갱신: 진단과 검토 상태를 단일 update()로 처리, 최신 state 기준
      update(current => {
        const latestTask = current.tasks.find(t => t.id === task.id) as import("@/lib/ax/types").AxTaskV2 | undefined;
        // 업무 삭제됨 → 응답 버림 (복원하지 않음)
        if (!latestTask) {
          setMessage("업무가 삭제되어 진단 결과를 반영하지 않았습니다.");
          return current;
        }
        // 업무 입력이 변경됨 → 오래된 응답 버림 (전체 입력 기준)
        // 요청 시점에 답변이 포함된 revised로 스냅샷했으므로, 비교 시에도 요청 시점의
        // 답변·질문으로 동일하게 재구성해야 함 (저장된 description에는 답변이 없음)
        const latestRevised = withAnswers
          ? followUpDescription(latestTask.description, requestQuestions, requestAnswers)
          : latestTask.description;
        const latestInput = JSON.stringify({
          name: latestTask.name,
          description: latestRevised,
          details: taskDetails(latestTask),
          attachmentSummary: sessionSummary(latestTask.id, taskAttachments(latestTask)) ?? null,
        });
        if (latestInput !== requestInput) {
          setMessage("업무 정보가 변경되어 이전 진단 결과를 반영하지 않았습니다.");
          return current;
        }
        const prevReviews = latestTask?.reviews ?? [];
        let nextReviews = prevReviews;
        if (prevReviews.length > 0 && latestTask?.diagnosis) {
          const newItems = extractReviewableItems(diagnosis);
          const reconciled = reconcileReviews(prevReviews, newItems);
          const now = new Date().toISOString();
          nextReviews = prevReviews.map(r => {
            const rec = reconciled.get(r.id);
            // changed(stale) 또는 ambiguous → confirmed를 stale로 전환, 기록 보존
            if ((rec?.status === "changed" || rec?.status === "ambiguous") && r.status === "confirmed") {
              return { ...r, status: "stale" as const, updatedAt: now };
            }
            return r;
          });
        }
        return {
          ...current,
          tasks: current.tasks.map(t => t.id === task.id
            ? { ...t, diagnosis, status: taskStatus(diagnosis), reviews: nextReviews, updatedAt: new Date().toISOString() }
            : t),
        };
      });
      setAnswers(current => ({ ...current, [task.id]: [] })); setMessage("업무 진단을 완료했습니다. 필요한 경우 점수를 조정하세요.");
    } catch (error) { if (alive.current) setMessage(`진단 실패 · ${aiFailureDetail(error)}`); }
    finally { activeAi.current = false; activeRun.current = false; if (alive.current) setBusy(null); }
  }
  function adjust(task: AxTask, key: FactorKey, input: string) {
    const value = input === "" ? undefined : Number(input);
    if (!task.diagnosis || (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 5))) return;
    const factor = task.diagnosis.factors.find(f => f.key === key);
    if (!factor) return;
    const prevEffective = factorEffectiveValue(factor);
    const nextFinal = input === "" || value === factor.aiValue ? undefined : value;
    const nextFactor = { ...factor, finalValue: nextFinal };
    const nextEffective = factorEffectiveValue(nextFactor);
    const effectiveChanged = prevEffective !== nextEffective;
    const diagnosis: AxDiagnosis = { ...task.diagnosis,
      ...(effectiveChanged ? { planCodex: undefined, planClaude: undefined } : {}),
      factors: task.diagnosis.factors.map(f => f.key === key ? nextFactor : f),
    };
    patchTask(task.id, { diagnosis, status: taskStatus(diagnosis) });
  }
  async function generatePlan(task: AxTask, target: "codex" | "claude") {
    if (!task.diagnosis || activeRun.current) return;
    if (!planAllowed(task.diagnosis)) { setMessage("현재 조건에서는 구현 계획을 생성할 수 없습니다. 선행 조치를 먼저 해결하세요."); return; }
    activeRun.current = true; activeAi.current = true; setBusy(target); setMessage("");
    // 요청 시점 기준 상태 기록 (오래된 AI 응답 적용 방지)
    const requestBaseline = {
      taskId: task.id,
      name: task.name,
      description: task.description,
      details: JSON.stringify(taskDetails(task)),
      diagnosis: JSON.stringify(confirmedAxDiagnosis(task.diagnosis)),
      planExists: target === "codex" ? !!task.diagnosis.planCodex : !!task.diagnosis.planClaude,
    };
    try {
      const confirmed = confirmedAxDiagnosis(task.diagnosis);
      const plan = await planAx({ kind: "ax-plan", target, task: { name: task.name, description: task.description, details: taskDetails(task) }, diagnosis: confirmed });
      if (!alive.current) return;
      // 응답 도착 시 최신 상태와 기준 상태 비교 (getState()로 최신 상태 조회 - stale closure 방지)
      const latestTask = getState().tasks.find(t => t.id === requestBaseline.taskId) as import("@/lib/ax/types").AxTaskV2 | undefined;
      if (!latestTask) { setMessage("업무가 삭제되어 계획 생성을 중단했습니다."); return; }
      const latestDiagnosis = latestTask.diagnosis;
      const baselineMatches = latestDiagnosis
        && latestTask.name === requestBaseline.name
        && latestTask.description === requestBaseline.description
        && JSON.stringify(taskDetails(latestTask)) === requestBaseline.details
        && JSON.stringify(confirmedAxDiagnosis(latestDiagnosis)) === requestBaseline.diagnosis
        && (target === "codex" ? !!latestDiagnosis.planCodex : !!latestDiagnosis.planClaude) === requestBaseline.planExists;
      if (!baselineMatches) {
        setMessage("업무 정보가 변경되어 이전 계획 생성을 반영하지 않았습니다. 최신 상태로 다시 생성하세요.");
        return;
      }
      // HITL: 계획 재생성 시 기존 계획 검토와 새 계획 비교 → 변경된 항목 stale
      // 원자적 갱신: 계획과 검토 상태를 단일 update()로 처리, 최신 state 기준
      // 다른 도구의 계획·검토는 보존
      update(current => {
        const freshTask = current.tasks.find(t => t.id === task.id) as import("@/lib/ax/types").AxTaskV2 | undefined;
        const prevReviews = freshTask?.reviews ?? [];
        let nextReviews = prevReviews;
        const planSource = target === "codex" ? "planCodex" : "planClaude";
        const prevPlanReviews = prevReviews.filter(r => r.target.source === planSource);
        if (prevPlanReviews.length > 0) {
          const newItems = extractPlanReviewableItems(plan, target);
          const reconciled = reconcileReviews(prevPlanReviews, newItems);
          const now = new Date().toISOString();
          const staleIds = new Set<string>();
          for (const [id, rec] of reconciled) {
            if ((rec.status === "changed" || rec.status === "ambiguous") && rec.review.status === "confirmed") {
              staleIds.add(id);
            }
          }
          if (staleIds.size > 0) {
            nextReviews = prevReviews.map(r => staleIds.has(r.id) ? { ...r, status: "stale" as const, updatedAt: now } : r);
          }
        }
        const planKey = target === "codex" ? "planCodex" : "planClaude";
        // 기준 상태가 최신과 일치함을 확인했으므로 현재 진단을 기준으로 계획 적용
        const baseDiagnosis = freshTask?.diagnosis ?? (task as import("@/lib/ax/types").AxTaskV2).diagnosis;
        return {
          ...current,
          tasks: current.tasks.map(t => t.id === task.id
            ? { ...t, diagnosis: { ...baseDiagnosis, [planKey]: plan } as import("@/lib/ax/types").AxDiagnosis, reviews: nextReviews, updatedAt: new Date().toISOString() }
            : t),
        };
      });
      setMessage("구현 계획 생성 완료");
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
      if (state.tasks.length || storageProtection !== "writable") setConfirmation({ kind: "import", state: imported });
      else { const saved = await replace(imported); attachments.current.clear(); setSessionReady({}); clearDraft(); setMessage(saved ? "AI•AX 데이터를 가져왔습니다." : "AI•AX 데이터를 가져왔으나 브라우저 저장에 실패했습니다. 내보내기로 보관하세요."); }
    } catch (error) { setMessage((error as Error).message); }
  }
  async function confirm() {
    if (!confirmation) return;
    const action = confirmation; setConfirmation(null);
    if (action.kind === "delete") {
      attachments.current.delete(action.id); markSessionReady(action.id, []);
      if (editingId === action.id) clearDraft();
      update(current => { const tasks = current.tasks.filter(t => t.id !== action.id); return { ...current, tasks, selectedTaskId: current.selectedTaskId === action.id ? displayed.find(row => row.task.id !== action.id)?.task.id ?? tasks[0]?.id ?? null : current.selectedTaskId }; });
    } else {
      const saved = await replace(action.kind === "reset" ? emptyAxState() : action.state, action.kind === "reset");
      attachments.current.clear(); setSessionReady({}); clearDraft(); setAnswers({});
      setMessage(saved ? action.kind === "reset" ? "AI•AX 데이터를 초기화했습니다." : "AI•AX 데이터를 가져왔습니다." : "화면 데이터를 변경했으나 브라우저 저장에 실패했습니다. 새로고침 시 이전 데이터가 복원될 수 있습니다.");
    }
  }
  const diagnosedCount = state.tasks.filter(t => !!t.diagnosis).length;
  const nextStepDisabled = state.step === 1 ? state.tasks.length === 0 : diagnosedCount === 0;
  function taskRows(showActions: boolean) {
    const rows = state.step === 3 ? ranked : state.tasks.map(task => ({ task, rank: undefined }));
    return <ul className={`ax-task-rows${state.step === 3 ? " ax-matrix-list" : ""}`}>{rows.map(({ task, rank }) => {
      const l = task.diagnosis ? automationLevel(task.diagnosis) : null;
      const a = task.diagnosis ? axes(task.diagnosis) : null;
      const display = taskDisplayStatus(task);
      const statusText = `${STATUS[display.status]}${display.needsCheck ? " · 추가 질문 필요" : ""}`;
      const meta = state.step === 3 && a ? `가치 ${a.value} · 실현 ${a.feasibility}` : l ? `${statusText} · ${l.label.replace(/^L\d+ /, "")} · Level ${l.level}` : statusText;
      return <li key={task.id} className={selected?.id === task.id ? "is-selected" : undefined}><Button type="button" variant="ghost" className="ax-task-row-btn" aria-pressed={selected?.id === task.id} onClick={() => select(task.id)} disabled={!!busy}>
        <span className={`ax-dot ax-dot-${task.status}`} aria-hidden="true" /><span className="ax-task-name">{rank ? `${rank}. ` : ""}{task.name}</span><span className="ax-task-meta">{meta}</span>
      </Button>{showActions && state.step === 1 ? <span className="ax-task-actions">
        <Button type="button" variant="ghost" size="icon-sm" className="ax-task-action" aria-label="업무 수정" disabled={!!busy} onClick={() => editTask(task)}><Pencil size={15} aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" className="ax-task-action" aria-label="업무 삭제" disabled={!!busy} onClick={() => setConfirmation({ kind: "delete", id: task.id })}><Trash2 size={15} aria-hidden="true" /></Button>
      </span> : null}</li>;
    })}</ul>;
  }
  /** Step 3 좌측 업무 목록: 단일 선택, 기존 우선순위순 고정 */
  function matrixTaskRows() {
    return <ul className="ax-task-rows ax-matrix-list">{matrixListed.map(({ task, rank }) => {
      const a = axes(task.diagnosis);
      const gate = executionGate(task.diagnosis);
      const active = selected?.id === task.id;
      return <li key={task.id} className={active ? "is-selected" : undefined}>
        <Button type="button" variant="ghost" className="ax-task-row-btn" aria-pressed={active} onClick={() => select(task.id)} disabled={!!busy}>
          <span className={`ax-dot ax-dot-${task.status}`} aria-hidden="true" />
          <span className="ax-task-name">{rank}. {task.name}</span>
          {showScores ? <span className="ax-task-meta">가치 {a.value} · 실현 {a.feasibility}</span> : null}
          <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
        </Button>
      </li>;
    })}</ul>;
  }
  function priorityRows(top: boolean) {
    return <>{displayed.some((row, index) => row.rank !== index + 1) ? <p className="ax-muted ax-priority-order">번호는 우선순위 점수 기준이며, 실행 상태별로 표시합니다.</p> : null}<ol className="ax-priority-list" aria-label={top ? overviewIsTop ? "자동화 우선순위 TOP 목록" : "우선 확인 업무 목록" : "전체 진단 업무 목록"}>{(top ? overviewRows : displayed).map(r => {
      const l = automationLevel(r.task.diagnosis), m = matrixPosition(r.task.diagnosis), gate = executionGate(r.task.diagnosis);
      return <li key={r.task.id}><Button type="button" variant="ghost" className="ax-priority-row" aria-pressed={selected?.id === r.task.id} onClick={() => select(r.task.id)} disabled={!!busy}>
        <strong className="ax-rank">#{r.rank}</strong><span className="ax-priority-content"><span className="ax-priority-head"><span className="ax-task-name">{r.task.name}</span><span className="ax-region-chip" data-region={m.region}>{m.label}</span>{gate !== "ready" ? <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span> : null}</span>
        <span>{l.label.replace(/^L\d+ /, "")} · Level {l.level}{l.provisional ? " · 잠정" : ""}</span>{top ? <small className="ax-next-action"><span>다음 권장 행동</span>{nextAction(r.task.diagnosis).label}</small> : <small>{r.reason}</small>}{top ? <small>점수 {r.score}</small> : null}</span>
      </Button></li>;
    })}</ol></>;
  }
  /** 첨부 파일 1개만 해제한다. 나머지 파일과 그 요약은 유지되며, 첨부 구성이 바뀌었으므로 기존 진단은 무효화된다. */
  function detachFile(task: AxTask, fingerprint: string) {
    const remaining = taskAttachments(task).filter(meta => meta.fingerprint !== fingerprint);
    const session = (attachments.current.get(task.id) ?? []).filter(entry => entry.meta.fingerprint !== fingerprint);
    if (session.length) attachments.current.set(task.id, session);
    else attachments.current.delete(task.id);
    markSessionReady(task.id, session.map(entry => entry.meta.fingerprint));
    patchTask(task.id, { ...attachmentPatch(remaining), diagnosis: undefined, status: "registered" });
    setMessage(remaining.length ? "첨부 파일 1개를 해제했습니다. 변경된 첨부 구성으로 다시 진단하세요." : "첨부를 해제했습니다. 등록 정보로 다시 진단할 수 있습니다.");
  }
  return <section className="ax-view" aria-label="업무 자동화 진단" aria-busy={!!busy}>
    <div className="ax-data-actions">
      {message ? <p role="status" className="ax-utility-message">{message}</p> : null}
      <Menu><MenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="AI•AX 데이터 작업" disabled={!ready || !!busy} />}><MoreHorizontal aria-hidden="true" /></MenuTrigger><MenuPopup align="end">
        <MenuItem onClick={download}><Upload aria-hidden="true" />데이터 내보내기</MenuItem>
        <MenuItem onClick={() => importInput.current?.click()}><Download aria-hidden="true" />데이터 가져오기</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => setConfirmation({ kind: "reset" })}><Trash2 aria-hidden="true" />데이터 초기화</MenuItem>
      </MenuPopup></Menu>
      <input ref={importInput} type="file" hidden accept=".json,application/json" aria-label="AI•AX 데이터 가져오기 파일" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void acceptImport(file); }} />
    </div>
    {saveStatus === "저장 실패" ? <p role="status" className="ax-notice">자동 저장에 실패했습니다. 필요하면 AI•AX 데이터를 내보내 백업해주세요.</p> : null}
    {loadNotice ? <p role="status" className="ax-notice">{loadNotice}</p> : null}
    {externalChange ? <p role="status" className="ax-notice">다른 탭에서 AI•AX 데이터가 변경되어 원본 보호를 위해 자동 저장을 중단했습니다. 현재 화면의 변경은 먼저 내보내기로 보관하세요. 새로고침하면 다른 탭의 최신 데이터를 불러옵니다. <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>새로고침</Button></p> : null}
    {!ready ? <p role="status">AI•AX 데이터를 불러오는 중…</p> : <Tabs value={String(state.step)} onValueChange={value => changeStep(Number(value))}>
      <TabsList className="ax-steps" aria-label="진단 단계">{STEPS.map((s, i) => { const Icon = STEP_ICONS[i]; return <TabsTab key={s} value={String(i + 1)} disabled={!!busy}><Icon size={15} aria-hidden="true" /><span>{s}</span></TabsTab>; })}</TabsList>
      <TabsPanel value="1">
        <div className="ax-step1-grid">
          <form className="ax-surface ax-register ax-area-form" onSubmit={register}><h2>{editingId ? "등록 정보 수정" : "업무 등록"}</h2>
            <div className="ax-field"><label className="ax-field">업무명<Input type="text" value={name} maxLength={AX_LIMITS.name} onChange={e => setName(e.target.value)} disabled={!!busy} aria-describedby={nameHelpId} /></label><small id={nameHelpId}>비워두면 업무 설명을 기준으로 자동 생성</small></div>
            <label className="ax-field"><span className="ax-required-label">업무 설명</span><Textarea value={description} required maxLength={AX_LIMITS.description} onChange={e => setDescription(e.target.value)} disabled={!!busy} placeholder="반복 업무·입력 자료·결과물 설명" rows={5} /></label>
            <div className="ax-register-files">
              <AxAttachmentInput disabled={!!busy} onSelectFiles={files => void attachFiles(files)} />
              {draftAttachments.map(entry => <div className="ax-file-row" key={entry.meta.fingerprint}><FileText className="size-4" aria-hidden="true" /><span className="ax-file-name">{entry.meta.name}</span><span className="ax-file-status">{entry.summary !== null ? "준비됨" : "재첨부 필요"}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="첨부 취소" onClick={() => removeDraftAttachment(entry.meta.fingerprint)} disabled={!!busy}><X aria-hidden="true" /></Button></div>)}
            </div>
            <Accordion><AccordionItem value="details">
              <div className="ax-register-actions"><AccordionTrigger type="button" className="ax-details-trigger" disabled={!!busy}>추가 정보</AccordionTrigger><div className="ax-register-submit">{editingId ? <Button type="button" variant="ghost" onClick={clearDraft}>수정 취소</Button> : null}<Button type="submit" disabled={!!busy || !description.trim()}>{editingId ? "수정 등록" : "업무 등록"}</Button></div></div>
              <AccordionPanel><div className="ax-form-grid">{DETAILS.map(({ key, label, placeholder, numeric }) => <label className="ax-field" key={key}>{label}<Input type={numeric ? "number" : "text"} min={numeric ? 0 : undefined} max={numeric ? 100000 : undefined} step="any" maxLength={numeric ? undefined : AX_LIMITS.detail} placeholder={placeholder} value={details[key] ?? ""} onChange={e => setDetails(current => ({ ...current, [key]: e.target.value }))} disabled={!!busy} /></label>)}</div></AccordionPanel>
            </AccordionItem></Accordion>
          </form>
          {state.tasks.length ? <section className="ax-surface ax-area-list" aria-label="등록 업무 목록"><h3>업무 목록</h3>{taskRows(true)}</section> : null}
        </div>
      </TabsPanel>
      <TabsPanel value="2">
        {!state.tasks.length ? <p className="ax-empty ax-muted">진단할 업무를 먼저 등록하세요</p> : <div className="ax-step2-grid">
          <section className="ax-surface" aria-label="등록 업무 목록"><h3>업무 목록</h3>{taskRows(false)}</section>
          <div className="ax-detail-col">{selected ? <>
            <DiagnosisCard task={selected} busy={busy} onDiagnose={() => void diagnose(selected)} onEdit={() => editTask(selected)}
              attachment={<TaskAttachment task={selected} busy={busy} ready={new Set(sessionReady[selected.id] ?? [])} onDetachFile={fingerprint => detachFile(selected, fingerprint)} onAttachFiles={files => void attachFiles(files, selected.id)} />} />
            {selected.diagnosis ? <>
              {selected.diagnosis.followUpQuestions.length ? <section className="ax-surface ax-questions" id="ax-answer-section" aria-label="추가 질문 답변"><h3>추가 질문 {selected.diagnosis.followUpQuestions.length}개</h3>{selected.diagnosis.followUpQuestions.map((q, i) => <label className="ax-field" key={i}>{q}<Textarea rows={2} maxLength={500} disabled={!!busy} value={answers[selected.id]?.[i] ?? ""} onChange={e => setAnswers(current => { const values = [...(current[selected.id] ?? [])]; values[i] = e.target.value; return { ...current, [selected.id]: values }; })} /></label>)}<Button type="button" className="ax-rediagnose" disabled={!!busy} onClick={() => void diagnose(selected, true)}>답변 반영 후 재진단</Button></section> : null}
              <section className="ax-surface"><h3>진단 항목</h3><p className="ax-muted">필요하면 AI 평가값을 조정할 수 있습니다. 변경한 값은 자동화 수준과 우선순위에 바로 반영됩니다.</p>
                {selected.diagnosis.factors.map(f => { const { icon: Icon, color } = FACTOR_META[f.key], effective = factorEffectiveValue(f), adjusted = factorHasAdjustment(f); const style = { "--ax-factor": color } as CSSProperties; return <div className="ax-factor-row" key={f.key}>
                  <span className="ax-factor-icon" style={style}><Icon size={16} aria-hidden="true" /></span>
                  <div className="ax-factor-main"><div className="ax-factor-head"><h4>{FACTOR_LABELS[f.key]}</h4><span className="ax-muted">AI {f.aiValue}점</span>{adjusted ? <span className="ax-factor-corrected">사용자 보정</span> : null}</div><p>{f.rationale}</p><small>{factorScale(f.key)}</small></div>
                  <div className="ax-factor-control"><div className="ax-segments" role="group" aria-label={`${FACTOR_LABELS[f.key]} 보정`}>{[1, 2, 3, 4, 5].map(v => <button type="button" key={v} className={v <= effective ? "is-on" : ""} style={style} aria-label={`${FACTOR_LABELS[f.key]} ${v}점`} aria-pressed={v === effective} disabled={!!busy} onClick={() => adjust(selected, f.key, String(v))} />)}</div><strong className="ax-factor-value" style={{ color }}>{effective}</strong>{adjusted ? <AiValueReset disabled={!!busy} onReset={() => adjust(selected, f.key, "")} /> : null}</div>
                </div>; })}
              </section>
              <AxProcess
                diagnosis={selected.diagnosis}
                reviewProps={{
                  taskId: selected.id,
                  reviews: (selected as import("@/lib/ax/types").AxTaskV2).reviews ?? [],
                  onSaveReview: (r) => saveHitlReview(selected.id, r),
                }}
              />
            </> : null}
          </> : null}</div>
        </div>}
      </TabsPanel>
      <TabsPanel value="3">
        {!ranked.length ? <><div className="ax-matrix-header">{matrixStatus}</div><p className="ax-empty ax-muted">진단 결과 업무 없음</p></> : <div className="ax-step3-rows">
          <div className="ax-step3-grid">
            <div className="ax-step3-taskcol">
            <section className="ax-surface ax-matrix-task-panel" aria-label="매트릭스 업무 목록">
              <div className="ax-matrix-list-head"><h3>업무 목록 ({ranked.length})</h3></div>
              {matrixTaskRows()}
            </section>
            </div>
            <section className="ax-surface ax-matrix-surface" aria-label="자동화 매트릭스">
              <div className="ax-matrix-header"><h2>자동화 매트릭스</h2>{matrixStatus}
                <div className="ax-matrix-tools">
                  <Menu><MenuTrigger render={<Button type="button" variant="outline" size="sm" />}><SlidersHorizontal size={14} aria-hidden="true" />보기 옵션</MenuTrigger>
                    <MenuPopup>
                      <MenuCheckboxItem checked={showScores} onCheckedChange={setShowScores}>점수 표시</MenuCheckboxItem>
                    </MenuPopup>
                  </Menu>
                  <Button type="button" variant="outline" size="sm" aria-pressed={showMatrixHelp} onClick={() => setShowMatrixHelp(v => !v)}><CircleHelp size={14} aria-hidden="true" />도움말</Button>
                </div>
              </div>
              {showMatrixHelp ? <div className="ax-matrix-help" role="note" aria-label="매트릭스 도움말">
                <div><h4>축 점수·진행 상태·우선순위 기준</h4>
                  <p>자동화 가치: 반복성·규칙성·데이터 구조화 평균 (1~5점)</p>
                  <p>기술 실현 가능성: 규칙성·데이터 구조화·시스템 접근성 평균 (1~5점)</p>
                  <p>진행 상태: Level·Gate 기준 판정 (매트릭스 위치와 다를 수 있음)</p>
                  <p>우선순위: 종합 정책 점수 기준</p>
                </div>
                <div><h4>원 크기 기준</h4>
                  <p>원 크기: 월간 업무 투입시간 기준</p>
                </div>
              </div> : null}
              <AxMatrix rows={ranked} selectedId={selected?.id} onSelect={select} step={state.step} />
              <div className="ax-matrix-legend" aria-label="매트릭스 범례">
                <span className="ax-legend-item"><span className="ax-legend-dot" data-gate="ready" aria-hidden="true" />진행 가능</span>
                <span className="ax-legend-item"><span className="ax-legend-dot" data-gate="conditional" aria-hidden="true" />확인 후 진행</span>
                <span className="ax-legend-item"><span className="ax-legend-dot" data-gate="blocked" aria-hidden="true" />진행 보류</span>
              </div>
            </section>
          </div>
          {selected?.diagnosis ? <MatrixDetailCard task={selected} diagnosis={selected.diagnosis} /> : <section className="ax-surface" aria-label="선택 업무 상세"><p className="ax-muted">업무 목록에서 업무를 선택하면 상세 분석이 표시됩니다.</p></section>}
        </div>}
      </TabsPanel>
      <TabsPanel value="4">
        {!ranked.length ? <p className="ax-empty ax-muted">완료된 진단 결과 없음</p> : <>
          <aside className="ax-step4-overview" aria-label="전체 업무 현황">
            <AxKpiCards tasks={state.tasks} />
            <div className="ax-step4-overview-grid">
              <section className="ax-surface"><h3>{overviewHeading}</h3>{priorityRows(true)}{ranked.length > overviewRows.length ? <Accordion className="ax-all-tasks"><AccordionItem value="all-tasks"><AccordionTrigger>전체 업무 보기</AccordionTrigger><AccordionPanel><div className="ax-all-task-list">{priorityRows(false)}</div></AccordionPanel></AccordionItem></Accordion> : null}</section>
            </div>
          </aside>
          {selected?.diagnosis ? <article className="ax-selected-report" aria-label={`${selected.name} 결과·로드맵`}>
            <header className="ax-report-intro"><div><span className="ax-report-eyebrow">선택한 업무 · 결과·로드맵</span><div className="ax-title-group"><h2>{selected.name}</h2><Badge className="ax-status-badge">{STATUS[taskDisplayStatus(selected).status]}</Badge>{taskDisplayStatus(selected).needsCheck ? <span className="ax-status-note">추가 질문 필요</span> : null}</div><p>{selected.description}</p></div></header>
            <AxResultSummary task={selected} />
            <AxExecutionTimeline diagnosis={selected.diagnosis} />
            <AxPlanSection
              key={selected.id}
              diagnosis={selected.diagnosis}
              taskName={selected.name}
              taskContext={[selected.description, ...Object.entries(taskDetails(selected)).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`)].join("\n")}
              busy={busy}
              onGenerate={target => void generatePlan(selected, target)}
              reviewProps={{
                taskId: selected.id,
                reviews: (selected as import("@/lib/ax/types").AxTaskV2).reviews ?? [],
                onSaveReview: (r) => saveHitlReview(selected.id, r),
              }}
            />
          </article> : <p className="ax-muted">우선순위에서 업무 선택 후 상세 결과 확인</p>}
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
/** Step 2 selected-task card: name/badges → description → diagnosis summary → 4 score cards → checks. Follow-up questions render once, in the answer section below this card. */
function DiagnosisCard({ task, busy, onDiagnose, onEdit, attachment }: {
  task: AxTask; busy: string | null; onDiagnose: () => void; onEdit: () => void; attachment: ReactNode;
}) {
  const display = taskDisplayStatus(task);
  const d = task.diagnosis;
  const lvl = d ? automationLevel(d) : null;
  const gate = d ? executionGate(d) : null;
  const checks = d ? diagnosisCheckItems(d) : [];
  // 추가 질문이 같은 주제로 묻고 있는 확인 항목은 질문 영역에서 확인하므로 목록에서 중복 표시하지 않는다.
  const visibleChecks = d ? visibleDiagnosisCheckItems(d) : [];
  return <section className="ax-surface ax-diag-card" aria-label={`${task.name} 진단`}>
    <div className="ax-diag-head">
      <div className="ax-diag-title">
        <h2>{task.name}</h2>
        <div className="ax-diag-badges">
          {display.status === "needs-info" || display.needsCheck ? <Badge className="ax-status-badge">정보 확인 필요</Badge> : null}
          {display.status === "adjusted" ? <Badge className="ax-status-badge">사용자 보정 완료</Badge> : null}
          {d && lvl && gate ? <>
            <Badge className="ax-level-badge">{lvl.label.replace(/^L\d+ /, "")} · Level {lvl.level}</Badge>
            {lvl.provisional ? <span className="ax-provisional">잠정</span> : null}
            <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
          </> : null}
        </div>
      </div>
      <div className="ax-diag-actions">
        <Button type="button" disabled={!!busy} onClick={onDiagnose}>{busy === task.id ? "진단 중…" : d ? "업무 다시 진단" : "업무 진단 실행"}</Button>
        <Button type="button" variant="outline" onClick={onEdit} disabled={!!busy}>등록 정보 수정</Button>
      </div>
    </div>
    <p className="ax-diag-desc">{task.description}</p>
    {attachment}
    {d ? <>
      <div className="ax-diag-summary">
        <span className="ax-diag-summary-icon" aria-hidden="true"><FileText size={20} /></span>
        <div className="ax-diag-summary-body">
          <div className="ax-diag-summary-head"><h3>진단 결과 요약</h3><Badge variant={d.informationSufficiency === "sufficient" ? "success" : "warning"}>{SUFFICIENCY[d.informationSufficiency]}</Badge></div>
          {diagnosisSummarySentences(d).map((s, i) => <p key={i}>{s}</p>)}
          <p className="ax-diag-next"><span>다음 권장 행동</span><strong>{nextAction(d).label}</strong></p>
          <p className="ax-muted ax-diag-source">{d.sourceNote}</p>
        </div>
      </div>
      <AxScoreCards diagnosis={d} />
      {visibleChecks.length || !checks.length ? <section className="ax-diag-checks" aria-label="확인할 사항">
        <h3>확인할 사항 {visibleChecks.length}개</h3>
        {visibleChecks.length ? <ul>{visibleChecks.map((c, i) => <li key={i}>
          <span className="ax-check-icon"><AxCheckIcon title={c.title} /></span>
          <span className="ax-check-text"><strong>{c.title}</strong>{c.desc ? <small>{c.desc}</small> : null}</span>
          <span className="ax-check-badge" data-kind={c.kind}>{c.badge}</span>
        </li>)}</ul> : <p className="ax-muted">확인할 사항이 없습니다.</p>}
      </section> : null}
    </> : null}
  </section>;
}
/** Step 3 selected-task card: name/classification/badges → score cards → rationale/prerequisites → score evidence. */
function MatrixDetailCard({ task, diagnosis }: { task: AxTask; diagnosis: AxDiagnosis }) {
  const d = diagnosis;
  const lvl = automationLevel(d);
  const gate = executionGate(d);
  const m = matrixPosition(d);
  const gateChecks = splitGatePrerequisites(d);
  const profile = executionProfile(d);
  const next = nextAction(d);
  const sampleScope = profile.poc.inScope.filter(item => !item.startsWith("선행 확인사항")).slice(0, 2);
  const scope = gate === "blocked" ? "분석·검증만 가능 (기능 구현·운영 연결 불가)" : `${sampleScope.length ? sampleScope.join(" · ") : "샘플 데이터 검증"} — 조건에 의존하는 기능은 확인 후 구현`;
  return <section id={MATRIX_DETAIL_ID} tabIndex={-1} className="ax-surface ax-matrix-detail" aria-label={`${task.name} 매트릭스 상세`}>
    <div className="ax-matrix-detail-head">
      <div className="ax-diag-title">
        <span className="ax-detail-eyebrow">선택한 업무 · 상세 분석</span>
        <h3>{task.name}</h3>
        <div className="ax-diag-badges">
          <span className="ax-region-chip" data-region={m.region}>{m.label}</span>
          <Badge className="ax-level-badge">{lvl.label.replace(/^L\d+ /, "")} · Level {lvl.level}</Badge>
          {lvl.provisional ? <span className="ax-provisional">잠정</span> : null}
          <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
        </div>
      </div>
    </div>
    <AxScoreCards diagnosis={d} />
    <div className="ax-diag-cols ax-matrix-detail-cols">
      <div className="ax-matrix-detail-left">
        <section className="ax-matrix-rationale" aria-label="핵심 판단 근거">
          <h4><FileText size={16} aria-hidden="true" />핵심 판단 근거</h4>
          <ul>{matrixRationaleBullets(d).map((b, i) => <li key={i}>{b}</li>)}</ul>
        </section>
        {gate !== "ready" ? <section className="ax-matrix-gate-status" aria-label="현재 가능 범위 및 다음 조치">
          <h4><Info size={16} aria-hidden="true" />현재 가능 범위 및 다음 조치</h4>
          <div className="ax-scope-lines">
            <p><strong>현재 가능 범위</strong><span aria-hidden="true">—</span><span>{scope}</span></p>
            <p><strong>다음 조치</strong><span aria-hidden="true">—</span><span>{next.label} → 해결 후 업무 진단 단계에서 다시 진단해 상태 갱신</span></p>
          </div>
        </section> : null}
      </div>
      {gateChecks.required.length || gateChecks.recommended.length ? <section className="ax-matrix-prereqs" aria-label={gateChecks.required.length ? "선행 확인 조건" : "권장 확인사항"}>
        {gateChecks.required.length ? <>
          <h4><ListChecks size={16} aria-hidden="true" />선행 확인 조건 {gateChecks.required.length}개</h4>
          <ul>{gateChecks.required.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </> : null}
        {gateChecks.recommended.length ? <div className="ax-matrix-recommended">
          <h5>권장 확인사항 {gateChecks.recommended.length}개</h5>
          <ul>{gateChecks.recommended.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div> : null}
      </section> : null}
    </div>
    <AxScoreEvidence key={task.id} diagnosis={d} />
  </section>;
}
/** Attachment status as an element (not a render-time function call) so lint ref rules stay quiet. */
function TaskAttachment({ task, busy, ready, onDetachFile, onAttachFiles }: {
  task: AxTask; busy: string | null; ready: ReadonlySet<string>; onDetachFile: (fingerprint: string) => void; onAttachFiles: (files: File[]) => void;
}) {
  const metas = taskAttachments(task);
  if (!metas.length) return null;
  const missing = metas.some(meta => !ready.has(meta.fingerprint));
  return <div className="ax-attachment">
    {metas.map(meta => <div className="ax-file-row" key={meta.fingerprint}><FileText className="size-4" aria-hidden="true" /><span className="ax-file-name">{meta.name}</span><span className="ax-file-status">{" · "}{ready.has(meta.fingerprint) ? "세션 요약 준비됨" : "첨부 파일이 사용됨 — 재분석 시 재첨부 필요"}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="첨부 해제" disabled={!!busy} onClick={() => onDetachFile(meta.fingerprint)}><X aria-hidden="true" /></Button></div>)}
    {missing ? <AxAttachmentInput disabled={!!busy} onSelectFiles={onAttachFiles} /> : null}
  </div>;
}
/** Restores finalValue → aiValue; an outlined icon action so it never reads as the factor's own cycle icon. */
function AiValueReset({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  const label = "AI 제안값으로 되돌리기";
  return <Tooltip><TooltipTrigger render={<Button type="button" variant="outline" size="icon-sm" className="ax-factor-reset" aria-label={label} disabled={disabled} onClick={onReset} />}><RotateCcw aria-hidden="true" /></TooltipTrigger><TooltipPopup>{label}</TooltipPopup></Tooltip>;
}
function AxAttachmentInput({ disabled, onSelectFiles }: { disabled: boolean; onSelectFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="ax-field ax-file-input">
    <input ref={input} type="file" hidden multiple accept=".xlsx,.csv,.pdf,.docx,.pptx" aria-label="파일 추가" disabled={disabled} onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) onSelectFiles(files);
    }} />
    <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" />파일 추가</Button>
  </div>;
}
function AxKpiCards({ tasks }: { tasks: AxTask[] }) {
  const counts = diagnosisCounts(tasks);
  const ranked = priority(tasks);
  const knownMinutes = tasks.map(monthlyMinutes).filter((m): m is number => m !== null);
  return <div className="ax-kpi-cards">
    <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><ClipboardList size={14} aria-hidden="true" />등록 업무</span><strong>{tasks.length}개</strong></div>
    <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><CircleCheck size={14} aria-hidden="true" />진단 완료</span><strong>{counts.results}개</strong><small className="ax-muted">진행 가능 {counts.ready}개 · 확인 후 진행 {counts.conditional}개 · 진행 보류 {counts.blocked}개 · 추가 질문 필요 {counts.questions}개</small></div>
    {counts.results ? <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><Zap size={14} aria-hidden="true" />빠른 실행 후보</span><strong>{ranked.filter(r => matrixPosition(r.task.diagnosis).region === "quick" && executionGate(r.task.diagnosis) !== "blocked").length}개</strong><small className="ax-muted">빠른 실행 영역 · 확인 후 진행 포함 · 진행 보류 제외</small></div> : null}
    {knownMinutes.length ? <div className="ax-surface ax-kpi"><span className="ax-kpi-label"><Clock3 size={14} aria-hidden="true" />월 투입시간 합 · 입력 {knownMinutes.length}개</span><strong>{(knownMinutes.reduce((sum, m) => sum + m, 0) / 60).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}시간</strong></div> : null}
  </div>;
}
function AxMatrix({ rows, selectedId, onSelect, step }: {
  rows: RankedTask[]; selectedId?: string; onSelect: (id: string) => void; step: number;
}) {
  const max = Math.max(0, ...rows.map(({ task }) => monthlyMinutes(task) ?? 0));
  const groups = new Map<string, { position: { x: number; y: number; region: string; label: string }; rows: RankedTask[] }>();
  for (const row of rows) {
    const position = matrixPosition(row.task.diagnosis);
    // Serialize the renderer's final coordinates exactly: no rounding or policy recomputation.
    const key = JSON.stringify([position.x, position.y]);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { position, rows: [row] });
  }
  const groupSignature = JSON.stringify([...groups].map(([key, group]) => [key, group.rows.map(row => row.task.id).sort()]));
  const [openCluster, setOpenCluster] = useState<{ key: string; selectedId?: string; groupSignature: string; step: number } | null>(null);
  if (openCluster && (openCluster.selectedId !== selectedId || openCluster.groupSignature !== groupSignature || openCluster.step !== step)) setOpenCluster(null);
  // Gate 상태: 차트 위치와 실제 진행 가능 상태를 구분 (blocked > conditional > ready 순으로 대표값)
  const gateOf = (task: AxTask & { diagnosis: AxDiagnosis }) => executionGate(task.diagnosis);
  const worstGate = (members: RankedTask[]) => members.some(({ task }) => gateOf(task) === "blocked") ? "blocked" : members.some(({ task }) => gateOf(task) === "conditional") ? "conditional" : "ready";
  return <div className="ax-matrix-desktop"><div className="ax-matrix" aria-label="자동화 매트릭스 산점도">
    <div className="ax-region ax-region-strategic">전략 과제</div><div className="ax-region ax-region-quick">빠른 실행 후보</div><div className="ax-region ax-region-hold">수동 유지·보류</div><div className="ax-region ax-region-maybe">검토 후보</div>
    {[1, 2, 3, 4, 5].map(v => <span key={v} className="ax-y-tick" style={{ bottom: `${(v - 1) / 4 * 100}%` }}>{v === 1 ? "" : v}</span>)}
    {[1, 2, 3, 4, 5].map(v => <span key={v} className={`ax-x-tick${v === 1 ? " is-origin" : ""}`} style={v === 1 ? undefined : { left: `${(v - 1) / 4 * 100}%` }}>{v}</span>)}
    {[...groups].map(([key, group]) => {
      const m = group.position;
      if (group.rows.length === 1) {
        const { task, rank } = group.rows[0];
        const diameter = Math.sqrt(bubbleArea(task, max) / Math.PI) * 2;
        const gate = gateOf(task);
        return <button type="button" key={task.id} className={`ax-bubble${m.region === "hold" ? " is-hold" : ""}`} style={{ left: `${m.x}%`, bottom: `${m.y}%`, width: Math.max(24, diameter), height: Math.max(24, diameter), zIndex: selectedId === task.id ? 3 : 2 }} data-gate={gate} aria-label={`${task.name} · ${m.label} · 우선순위 ${rank} · ${GATE_LABELS[gate]}`} aria-pressed={selectedId === task.id} title={`${task.name} · ${m.label} · 우선순위 ${rank} · ${GATE_LABELS[gate]}`} onClick={() => onSelect(task.id)}><span className="ax-bubble-dot" style={{ width: diameter, height: diameter }} /><span className="ax-bubble-gate" data-gate={gate} aria-hidden="true" /></button>;
      }
      const members = [...group.rows].sort((a, b) => a.rank - b.rank);
      const selected = members.some(({ task }) => task.id === selectedId);
      const open = step === 3 && openCluster?.key === key && openCluster.selectedId === selectedId && openCluster.groupSignature === groupSignature && openCluster.step === step;
      // Keep the list on the roomy side of the point, inside the plot rather than over its axes.
      const side = m.y < 50 ? "top" : "bottom";
      const align = m.x < 25 ? "start" : m.x > 75 ? "end" : "center";
      const plotRoom = Math.max(80, Math.floor((side === "top" ? 100 - m.y : m.y) * 3.7 - 44));
      const groupGate = worstGate(members);
      const closeCluster = () => setOpenCluster(null);
      return <Menu key={key} modal={false} open={open} onOpenChange={nextOpen => setOpenCluster(nextOpen ? { key, selectedId, groupSignature, step } : null)}>
        <MenuTrigger render={<button type="button" />} className="ax-matrix-cluster" style={{ left: `${m.x}%`, bottom: `${m.y}%`, zIndex: selected ? 3 : 2 }} data-selected={selected} data-gate={groupGate} aria-label={`해당 위치의 업무 ${members.length}개`} title={`해당 위치의 업무 ${members.length}개`}>
          <span className="ax-matrix-cluster-circle ax-matrix-cluster-circle-left" aria-hidden="true" />
          <span className="ax-matrix-cluster-circle ax-matrix-cluster-circle-right" aria-hidden="true" />
          <span className="ax-matrix-cluster-circle ax-matrix-cluster-circle-front" aria-hidden="true" />
          <span className="ax-matrix-cluster-number" aria-hidden="true">{members.length}</span>
          <span className="ax-bubble-gate" data-gate={groupGate} aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup className="ax-matrix-cluster-popup" side={side} align={align} alignOffset={align === "center" ? 0 : align === "start" ? 28 : -28} sideOffset={12} style={{ "--ax-matrix-popup-height": `${plotRoom}px` } as CSSProperties} aria-label={`해당 위치의 업무 ${members.length}개`}>
          <div className="ax-matrix-cluster-head"><span className="ax-matrix-cluster-count">해당 위치의 업무 ({members.length}개)</span><button type="button" className="ax-matrix-cluster-close" aria-label="닫기" onClick={closeCluster}><X size={14} aria-hidden="true" /></button></div>
          <div className="ax-matrix-cluster-list" role="group" aria-label="해당 위치 업무 목록">
          {members.map(({ task, rank }) => {
            const a = axes(task.diagnosis);
            const gate = gateOf(task);
            // MenuItem 유지: 키보드 내비게이션(End/Home/방향키·Escape) 보존
            return <MenuItem key={task.id} closeOnClick={false} className="ax-matrix-cluster-item" data-active={task.id === selectedId ? "true" : undefined} aria-current={task.id === selectedId ? "true" : undefined} onClick={() => { onSelect(task.id); closeCluster(); }}>
              <span className="ax-matrix-cluster-rank">#{rank}</span>
              <span className="ax-matrix-cluster-main"><span className="ax-matrix-cluster-name">{task.name}</span>
                <span className="ax-matrix-cluster-meta">가치 {a.value} · 실현 {a.feasibility}</span></span>
              <span className="ax-gate-badge" data-gate={gate}>{GATE_LABELS[gate]}</span>
            </MenuItem>;
          })}
          </div>
        </MenuPopup>
      </Menu>;
    })}
    <span className="ax-y-label"><span className="ax-y-arrow" aria-hidden="true">↑</span><span className="ax-y-text">자동화 가치</span></span><span className="ax-x-label">기술 실현 가능성 →</span>
  </div></div>;
}
