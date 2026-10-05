import { AX_LIMITS, axDetailsSchema } from "./schema";
import type { AxTask } from "./types";
import { inputLimitFor } from "@/lib/parsers/policy";
export function candidateTask(description: string): AxTask {
  if (!description.trim() || description.length > AX_LIMITS.description) throw new Error("업무 설명은 1~3,000자로 입력하세요.");
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: description.trim().slice(0, 60), description: description.trim(), status: "registered", createdAt: now, updatedAt: now };
}
export function taskDetails(task: AxTask) {
  const { cycle, minutesPerRun, runsPerMonth, people, systems, inputs, outputs, humanSteps, painPoints, goal } = task;
  return axDetailsSchema.parse({ cycle, minutesPerRun, runsPerMonth, people, systems, inputs, outputs, humanSteps, painPoints, goal });
}

/** 메모리에서 요청 텍스트만 조합하며 원본 description 문자열 자체는 변경하지 않는 순수 함수다. */
export function followUpDescription(description: string, questions: string[], answers: string[]): string {
  const rows = questions.flatMap((q, index) => {
    const a = answers[index];
    return a?.trim() ? [`${q}: ${a}`] : [];
  });
  return rows.length ? `${description}\n추가 확인:\n${rows.join("\n")}` : description;
}

export function legacyDetailValues(task: AxTask): Partial<Pick<AxTask, "people" | "painPoints" | "goal">> {
  return {
    ...(task.people !== undefined ? { people: task.people } : {}),
    ...(task.painPoints !== undefined ? { painPoints: task.painPoints } : {}),
    ...(task.goal !== undefined ? { goal: task.goal } : {}),
  };
}

export function validateAttachmentPreflight(file: { name: string; size: number }): "csv" | "xlsx" | "docx" | "pptx" | "pdf" {
  const extension = /\.(csv|xlsx|docx|pptx|pdf)$/iu.exec(file.name.normalize("NFC").trim());
  if (!extension) throw new Error("지원하지 않는 파일 형식입니다. CSV·XLSX·DOCX·PPTX·PDF 파일을 선택하세요.");
  const kind = extension[1].toLowerCase() as "csv" | "xlsx" | "docx" | "pptx" | "pdf";
  if (file.size === 0) throw new Error("빈 파일은 첨부할 수 없습니다.");
  if (file.size > inputLimitFor(kind)) throw new Error("파일 크기가 허용 한도를 초과했습니다.");
  return kind;
}
