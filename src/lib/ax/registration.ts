import { AX_LIMITS, axDetailsSchema } from "./schema";
import type { AxTask } from "./types";
/** Line breaks and explicit numbered/bullet markers split candidates; punctuation in prose does not. */
export function splitTasks(input: string): string[] {
  return input.replace(/\r\n?/gu, "\n").replace(/(?:^|\s)(?:\d+[.)]|[•●▪])\s+/gu, "\n").split("\n")
    .map(line => line.replace(/^\s*[-*+]\s+/u, "").trim()).filter(Boolean);
}
export function candidateTask(description: string): AxTask {
  if (!description.trim() || description.length > AX_LIMITS.description) throw new Error("업무 설명은 1~3,000자로 입력하세요.");
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: description.trim().slice(0, 60), description: description.trim(), status: "registered", createdAt: now, updatedAt: now };
}
export function taskDetails(task: AxTask) {
  const { cycle, minutesPerRun, runsPerMonth, people, systems, inputs, outputs, humanSteps, painPoints, goal } = task;
  return axDetailsSchema.parse({ cycle, minutesPerRun, runsPerMonth, people, systems, inputs, outputs, humanSteps, painPoints, goal });
}
