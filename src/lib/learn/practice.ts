import type { LearnUnit } from "./types";

export type PracticeInputKind = "terminal" | "repetitive-jobs" | "writing";

export function practiceInputKind(unit: LearnUnit): PracticeInputKind {
  if (unit.practice?.commands?.length) return "terminal";
  return unit.id === "l1-u3" ? "repetitive-jobs" : "writing";
}

export interface PracticeJob {
  name: string;
  period: string;
  frequency: string;
  minutes: string;
}

export const practicePeriods = [
  { value: "day", label: "하루", days: 1 },
  { value: "week", label: "일주일", days: 7 },
  { value: "month", label: "한 달 (30일 기준)", days: 30 },
] as const;

export function blankPracticeJobs(): PracticeJob[] {
  return Array.from({ length: 3 }, () => ({ name: "", period: "", frequency: "", minutes: "" }));
}

export function normalizeJobName(name: string): string {
  return name.trim().replace(/\s+/gu, " ");
}

function positiveNumber(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
}

/** 입력 확인만 수행한다. 자동화 가능 여부나 점수를 판정하지 않는다. */
export function validatePracticeJobs(jobs: PracticeJob[]): string[] {
  const errors: string[] = [];
  if (jobs.length !== 3) errors.push("업무를 서로 다른 3개 작성해 주세요.");
  const names = jobs.map((job) => normalizeJobName(job.name));
  jobs.forEach((job, index) => {
    const prefix = `업무 ${index + 1}: `;
    if (!names[index]) errors.push(`${prefix}업무명을 입력해 주세요.`);
    if (!practicePeriods.some((period) => period.value === job.period)) {
      errors.push(`${prefix}반복 주기를 선택해 주세요.`);
    }
    if (!positiveNumber(job.frequency)) errors.push(`${prefix}반복 횟수는 0보다 큰 유효한 숫자로 입력해 주세요.`);
    if (!positiveNumber(job.minutes)) errors.push(`${prefix}1회 소요 시간은 0보다 큰 유효한 숫자(분)로 입력해 주세요.`);
    if (names[index] && names.indexOf(names[index]) !== index) {
      errors.push(`${prefix}공백을 정리했을 때 다른 업무와 같은 이름입니다. 서로 다른 업무 3개를 작성해 주세요.`);
    }
    const days = practicePeriods.find((period) => period.value === job.period)?.days;
    if (days && positiveNumber(job.frequency) && positiveNumber(job.minutes) &&
      !Number.isFinite(Number(job.frequency) * Number(job.minutes) * 30 / days)) {
      errors.push(`${prefix}횟수와 시간을 비교 가능한 크기의 숫자로 입력해 주세요.`);
    }
  });
  return errors;
}

/** 서로 다른 반복 주기를 비교하기 위한 30일 기준 추정 소요 시간. */
export function monthlyPracticeMinutes(job: PracticeJob): number {
  const days = practicePeriods.find((period) => period.value === job.period)!.days;
  return Number(job.frequency) * Number(job.minutes) * 30 / days;
}
