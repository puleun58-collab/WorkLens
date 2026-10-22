import { AX_LIMITS } from "./schema";
import type { AxAttachmentMeta, AxTask } from "./types";

/** 업무당 첨부 가능한 참고 파일 최대 개수. */
export const MAX_TASK_ATTACHMENTS = AX_LIMITS.attachments;

type AttachmentCarrier = Pick<AxTask, "attachmentMeta" | "attachmentMetas">;

/**
 * 저장된 첨부 메타데이터를 정규화된 목록으로 읽는다.
 * - 다중 첨부(attachmentMetas)가 있으면 그 목록이 기준이다.
 * - 단일 첨부 시절 데이터(attachmentMeta만 존재)도 1개 목록으로 읽힌다.
 */
export function taskAttachments(task: AttachmentCarrier): AxAttachmentMeta[] {
  if (task.attachmentMetas?.length) return task.attachmentMetas;
  return task.attachmentMeta ? [task.attachmentMeta] : [];
}

/**
 * 첨부 목록을 저장 필드로 변환한다. 대표 메타데이터(attachmentMeta)는 기존 데이터와의
 * 호환을 위해 첫 번째 파일을 가리키도록 항상 함께 유지한다.
 */
export function attachmentFields(metas: readonly AxAttachmentMeta[]): { attachmentMeta?: AxAttachmentMeta; attachmentMetas?: AxAttachmentMeta[] } {
  if (!metas.length) return {};
  if (metas.length === 1) return { attachmentMeta: metas[0] };
  return { attachmentMeta: metas[0], attachmentMetas: [...metas] };
}

/** patchTask 등 부분 갱신용: 두 필드를 모두 명시해 이전 다중 목록이 남지 않게 한다. */
export function attachmentPatch(metas: readonly AxAttachmentMeta[]): { attachmentMeta: AxAttachmentMeta | undefined; attachmentMetas: AxAttachmentMeta[] | undefined } {
  const fields = attachmentFields(metas);
  return { attachmentMeta: fields.attachmentMeta, attachmentMetas: fields.attachmentMetas };
}

/**
 * 파일 1개의 분석 요약. 기존 단일 첨부 시절과 동일한 형식이며,
 * 단일 파일만 있을 때 진단 입력이 바이트 단위로 달라지지 않는다.
 */
export function buildAttachmentSummary(kind: string, structure: { paragraphCount: number; tableCount: number }, topics: readonly { text: string }[]): string {
  return [`문서 유형: ${kind}`, `구조: 문단 ${structure.paragraphCount}개, 표 ${structure.tableCount}개`,
    ...topics.slice(0, 8).map(t => `주요 업무 단서: ${t.text.slice(0, 180)}`)].join("\n").slice(0, AX_LIMITS.attachmentSummary);
}

export const ATTACHMENT_TRUNCATION_NOTICE = "※ 일부 첨부 파일의 요약이 전체 길이 제한으로 축약되었습니다. 축약된 파일: ";

/**
 * 여러 파일의 개별 요약을 하나의 진단 입력(attachmentSummary)으로 통합한다.
 * - 파일별 출처 헤더를 붙여 파일 역할을 혼동하지 않는다.
 * - 파일이 1개면 그 파일 요약을 그대로 반환한다 (기존 진단 입력과 동일).
 * - 여러 파일에 걸쳐 완전히 동일한 업무 단서 줄은 한 번만 남긴다.
 * - 전체 길이 제한(AX_LIMITS.attachmentSummary)을 넘으면 파일별 균등 배분으로 축약하고,
 *   축약 사실을 숨기지 않고 말미에 고지한다.
 */
export function combineAttachmentSummaries(files: readonly { name: string; summary: string }[]): string | undefined {
  if (!files.length) return undefined;
  if (files.length === 1) return files[0].summary;
  const limit = AX_LIMITS.attachmentSummary;
  const seenClues = new Set<string>();
  const sections = files.map((file, index) => {
    const body = file.summary.split("\n").filter(line => {
      if (!line.startsWith("주요 업무 단서:")) return true;
      if (seenClues.has(line)) return false;
      seenClues.add(line);
      return true;
    }).join("\n");
    return `[첨부 파일 ${index + 1}: ${file.name}]\n${body}`;
  });
  const joined = sections.join("\n");
  if (joined.length <= limit) return joined;
  // 축약 고지 공간을 최악의 경우(전 파일 축약) 기준으로 먼저 확보한 뒤 파일별 균등 배분으로 본문을 줄이고,
  // 실제 고지에는 축약된 파일만 적는다 (고지 길이는 확보분 이하라 전체 제한을 넘지 않는다).
  const worstNotice = `${ATTACHMENT_TRUNCATION_NOTICE}${files.map(f => f.name).join(", ")}`;
  const bodyBudget = Math.max(0, limit - worstNotice.length - 1);
  const share = Math.max(0, Math.floor(bodyBudget / sections.length));
  const truncatedNames: string[] = [];
  const truncated = sections.map((section, index) => {
    if (section.length <= share) return section;
    truncatedNames.push(files[index].name);
    const cut = section.lastIndexOf("\n", share);
    return section.slice(0, cut > share / 2 ? cut : share);
  });
  const notice = `${ATTACHMENT_TRUNCATION_NOTICE}${truncatedNames.join(", ")}`;
  const combined = `${truncated.join("\n")}\n${notice}`;
  return combined.length <= limit ? combined : combined.slice(0, limit);
}
