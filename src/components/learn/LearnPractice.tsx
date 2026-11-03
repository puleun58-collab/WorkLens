"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LearnSeparatedText } from "./LearnSeparatedText";
import {
  blankPracticeJobs,
  monthlyPracticeMinutes,
  normalizeJobName,
  practicePeriods,
  validatePracticeJobs,
} from "@/lib/learn/practice";
import type { PracticeJob } from "@/lib/learn/practice";

export function WritingPractice({ steps }: { steps: string[] }) {
  const [notes, setNotes] = useState<string[]>(() => steps.map(() => ""));
  return (
    <div className="learn-writing-fields">
      <p className="learn-muted">자동 실행이나 정답 판정은 하지 않습니다. 작성 내용은 저장되지 않으며, 다른 단위로 이동하면 지워집니다. 비밀번호·API 키·개인정보는 입력하지 마세요.</p>
      {steps.map((step, index) => (
        <fieldset key={index}>
          <legend>{index + 1}. <LearnSeparatedText text={step} /></legend>
          <label className="learn-practice-field">
            <span>{index + 1}단계 작성 내용</span>
            <textarea
              rows={4}
              value={notes[index]}
              placeholder="안내에 맞는 초안, 판단 근거 또는 직접 확인한 내용을 적어 주세요."
              onChange={(event) => setNotes(notes.map((note, i) => i === index ? event.target.value : note))}
            />
          </label>
        </fieldset>
      ))}
    </div>
  );
}

export function RepetitiveJobsPractice() {
  const [jobs, setJobs] = useState(blankPracticeJobs);
  const [errors, setErrors] = useState<string[]>([]);
  const [compared, setCompared] = useState(false);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);

  const updateJob = (index: number, field: keyof PracticeJob, value: string) => {
    setJobs(jobs.map((job, i) => i === index ? { ...job, [field]: value } : job));
    setErrors([]);
    setCompared(false);
    setCandidate(null);
    setShowResult(false);
  };

  return (
    <form className="learn-practice-form" noValidate onSubmit={(event) => {
      event.preventDefault();
      const nextErrors = validatePracticeJobs(jobs);
      setErrors(nextErrors);
      setCompared(nextErrors.length === 0);
      setCandidate(null);
      setShowResult(false);
    }}>
      <p>반복되는 업무 3개를 작성하고, 자동화할 업무를 하나 선택해 보세요.</p>
      <p className="learn-muted"><strong>예:</strong> 업무명 ‘주간 보고서 취합’, 반복 주기 ‘일주일’, 횟수 ‘2’, 1회 소요 시간 ‘30분’. 예시는 입력되지 않습니다. 작성 내용은 저장되지 않으며, 다른 단위로 이동하면 지워집니다.</p>
      {jobs.map((job, index) => (
        <fieldset className="learn-practice-job" key={index}>
          <legend>업무 {index + 1}</legend>
          <label className="learn-practice-field">
            <span>업무명</span>
            <input required value={job.name} placeholder="예: 주간 보고서 취합" onChange={(event) => updateJob(index, "name", event.target.value)} />
          </label>
          <fieldset className="learn-practice-frequency">
            <legend>반복 주기 및 횟수</legend>
            <label className="learn-practice-field">
              <span>반복 주기</span>
              <select required value={job.period} onChange={(event) => updateJob(index, "period", event.target.value)}>
                <option value="">주기 선택</option>
                {practicePeriods.map((period) => <option key={period.value} value={period.value}>{period.label}</option>)}
              </select>
            </label>
            <label className="learn-practice-field">
              <span>반복 횟수 (회)</span>
              <input required type="number" min="0" step="any" value={job.frequency} placeholder="예: 2" onChange={(event) => updateJob(index, "frequency", event.target.value)} />
            </label>
          </fieldset>
          <label className="learn-practice-field">
            <span>1회 소요 시간 (분)</span>
            <input required type="number" min="0" step="any" value={job.minutes} placeholder="예: 30" onChange={(event) => updateJob(index, "minutes", event.target.value)} />
          </label>
        </fieldset>
      ))}
      {errors.length > 0 ? <div className="learn-practice-error" role="alert"><p>입력 내용을 확인해 주세요.</p><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
      <Button type="submit" variant="outline">업무 비교하기</Button>
      {compared ? (
        <section aria-label="업무 비교">
          <p className="learn-muted"><strong>업무 비교:</strong> 한 달을 30일로 환산한 예상 업무량입니다. 시간뿐 아니라 규칙·예외·위험도도 생각하며 후보를 직접 고르세요.</p>
          <div className="learn-practice-comparison">
            <table>
              <caption>업무별 반복 횟수와 예상 소요 시간 비교</caption>
              <thead><tr><th scope="col">업무명</th><th scope="col">반복 주기 및 횟수</th><th scope="col">1회 소요 시간</th><th scope="col">30일 기준 예상 시간</th></tr></thead>
              <tbody>{jobs.map((job, index) => <tr key={index}><th scope="row">{normalizeJobName(job.name)}</th><td>{practicePeriods.find((period) => period.value === job.period)!.label} {Number(job.frequency)}회</td><td>{Number(job.minutes)}분</td><td>{monthlyPracticeMinutes(job).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}분</td></tr>)}</tbody>
            </table>
          </div>
          <fieldset>
            <legend>자동화 후보 1개 선택</legend>
            {jobs.map((job, index) => <label className="learn-practice-candidate" key={index}><input type="radio" name="automation-candidate" value={index} checked={candidate === index} onChange={() => { setCandidate(index); setShowResult(false); }} />{normalizeJobName(job.name)}</label>)}
          </fieldset>
          <Button type="button" disabled={candidate === null} onClick={() => setShowResult(true)}>선택 결과 보기</Button>
          {showResult && candidate !== null ? <div className="learn-practice-result" role="status"><p><strong>선택한 자동화 후보:</strong> {normalizeJobName(jobs[candidate].name)}</p><p>30일 기준 예상 소요 시간은 {monthlyPracticeMinutes(jobs[candidate]).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}분입니다.</p><p>이 결과는 직접 선택한 연습용 후보이며, 자동화 가능 여부를 확정하는 평가가 아닙니다. 규칙의 명확성, 자료 형태, 예외, 승인 필요성을 추가로 확인하세요. 연습 결과는 점수에 반영되지 않습니다.</p></div> : null}
        </section>
      ) : null}
    </form>
  );
}
