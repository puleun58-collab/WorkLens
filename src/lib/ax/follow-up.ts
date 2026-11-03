import { AX_LIMITS } from "./schema";
import type { AxFollowUpResponse, AxTaskV2 } from "./types";

/** Only exact question identity reconnects records; array order and semantic guesses never do. */
export function followUpResponse(task: Pick<AxTaskV2, "followUpResponses">, question: string): AxFollowUpResponse | undefined {
  return task.followUpResponses?.find(record => record.question === question);
}
export function upsertFollowUpResponse(records: readonly AxFollowUpResponse[] | undefined, record: AxFollowUpResponse): AxFollowUpResponse[] {
  const previous = records ?? [];
  if (previous.some(item => item.id === record.id && item.question !== record.question)) throw new Error("질문 연결이 변경되었습니다");
  if (!previous.some(item => item.id === record.id) && previous.length >= 100) throw new Error("저장 가능한 질문 기록 수를 초과했습니다");
  return previous.some(item => item.id === record.id)
    ? previous.map(item => item.id === record.id ? record : item)
    : [...previous, record];
}
/** Saved answers remain useful after a re-diagnosis stops asking the same question. */
export function followUpContext(records: readonly AxFollowUpResponse[] | undefined): string {
  return (records ?? []).filter(record => record.answer.trim() || record.attachments.length).map(record => [
    `질문: ${record.question}`,
    record.answer.trim() ? `사용자 답변: ${record.answer.trim()}` : "텍스트 답변 없음",
    ...record.attachments.map(file => `첨부 자료: ${file.name} — 이 브라우저에 보관된 파일입니다. 파일 내용 확인은 재진단 시 실제 추출된 범위에 한합니다. 코딩 에이전트에 원본을 별도로 제공해야 합니다.`),
  ].join("\n")).join("\n\n");
}
export function followUpDiagnosisDescription(description: string, records: readonly AxFollowUpResponse[] | undefined): string {
  const rows = (records ?? []).filter(record => record.answer.trim()).map(record => `${record.question}: ${record.answer.trim()}`);
  const result = rows.length ? `${description}\n추가 확인:\n${rows.join("\n")}` : description;
  if (result.length > AX_LIMITS.description) throw new Error("답변을 포함한 설명은 3,000자 이하여야 합니다. 등록 정보와 답변을 정리하세요");
  return result;
}
