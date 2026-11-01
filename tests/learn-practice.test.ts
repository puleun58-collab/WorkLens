import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RepetitiveJobsPractice, WritingPractice } from "@/components/learn/LearnPractice";
import { LearnSeparatedText } from "@/components/learn/LearnSeparatedText";
import { allContents } from "@/lib/learn/content";
import {
  blankPracticeJobs,
  monthlyPracticeMinutes,
  normalizeJobName,
  practiceInputKind,
  validatePracticeJobs,
} from "@/lib/learn/practice";
import type { PracticeJob } from "@/lib/learn/practice";

const validJobs = (): PracticeJob[] => [
  { name: "보고서 취합", period: "day", frequency: "1", minutes: "10" },
  { name: "메일 분류", period: "week", frequency: "7", minutes: "10" },
  { name: "정산 확인", period: "month", frequency: "30", minutes: "10" },
];

describe("작성형 연습 입력 확인", () => {
  test("처음에는 서로 독립된 빈 업무 3개이며 필수 항목을 안내한다", () => {
    const jobs = blankPracticeJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs).toEqual(Array.from({ length: 3 }, () => ({ name: "", period: "", frequency: "", minutes: "" })));
    jobs[0].name = "첫 업무";
    expect(jobs[1].name).toBe("");
    expect(validatePracticeJobs(blankPracticeJobs())).toHaveLength(12);
  });

  test("서로 다른 3개 업무의 양수 횟수·시간만 허용한다", () => {
    expect(validatePracticeJobs(validJobs())).toEqual([]);
    expect(validatePracticeJobs(validJobs().slice(0, 2))).not.toEqual([]);
    for (const value of ["", " ", "0", "-1", "NaN", "Infinity", "abc"]) {
      for (const field of ["frequency", "minutes"] as const) {
        const jobs = validJobs();
        jobs[0][field] = value;
        expect(validatePracticeJobs(jobs), `${field}: ${value}`).not.toEqual([]);
      }
    }
    const jobs = validJobs();
    jobs[0].frequency = "0.5";
    jobs[0].minutes = "2.5";
    expect(validatePracticeJobs(jobs)).toEqual([]);
    jobs[0].period = "year";
    expect(validatePracticeJobs(jobs)).not.toEqual([]);
  });

  test("업무명 앞뒤·연속 공백을 정리하여 중복을 거절한다", () => {
    const jobs = validJobs();
    jobs[1].name = " \t보고서   취합\n";
    expect(normalizeJobName(jobs[1].name)).toBe("보고서 취합");
    expect(validatePracticeJobs(jobs).some((message) => message.includes("같은 이름"))).toBe(true);
    jobs[1].name = " \t\n";
    expect(validatePracticeJobs(jobs).some((message) => message.includes("업무명을 입력"))).toBe(true);
  });

  test("다른 주기의 업무를 동일한 30일 기준으로 비교한다", () => {
    expect(validJobs().map(monthlyPracticeMinutes)).toEqual([300, 300, 300]);
    const jobs = validJobs();
    jobs[0].frequency = "1e308";
    jobs[0].minutes = "1e308";
    expect(validatePracticeJobs(jobs).some((message) => message.includes("비교 가능한 크기"))).toBe(true);
  });
});

describe("LEVEL 1~10 실습 입력 방식", () => {
  test("명령어가 있는 CLI·Git만 터미널을 사용한다", () => {
    for (const content of allContents()) {
      for (const unit of content.units.filter((unit) => unit.practice)) {
        const kind = practiceInputKind(unit);
        if (content.level === 4 || content.level === 5) {
          expect(kind, unit.id).toBe("terminal");
          expect(unit.practice!.commands!.length, unit.id).toBeGreaterThan(0);
        } else {
          expect(kind, unit.id).toBe(unit.id === "l1-u3" ? "repetitive-jobs" : "writing");
        }
        expect(unit.practice!.title, unit.id).not.toContain(" — ");
      }
    }
  });

  test("표시용 라벨만 굵게 하고 명령·경로·문장 속 콜론은 보존한다", () => {
    expect(renderToStaticMarkup(createElement(LearnSeparatedText, { text: "총무팀: 월간 보고서를 정리한다." }))).toBe("<strong>총무팀:</strong> 월간 보고서를 정리한다.");
    expect(renderToStaticMarkup(createElement(LearnSeparatedText, { text: "정답: 보고서 화면 = src/pages/report.tsx." }))).toBe("<strong>정답:</strong> 보고서 화면 = src/pages/report.tsx.");
    for (const text of ["git commit -m initial", "https://github.com/example/team-docs.git", "C:\\Users\\학습자", "공백이 있는 이름은 따옴표로 감쌉니다. 예: cd docs."]) {
      expect(renderToStaticMarkup(createElement(LearnSeparatedText, { text }))).not.toContain("<strong>");
    }
    for (const content of allContents()) {
      expect(JSON.stringify(content), `LEVEL ${content.level}`).not.toMatch(/ [—–] | - /);
    }
  });

  test("반복 업무 폼은 빈 필수 입력으로 시작하고 비교 전에 후보·결과를 보여주지 않는다", () => {
    const html = renderToStaticMarkup(createElement(RepetitiveJobsPractice));
    expect(html.match(/<legend>업무 \d<\/legend>/g)).toHaveLength(3);
    expect(html.match(/required=""/g)).toHaveLength(12);
    expect(html).toContain("업무명");
    expect(html).toContain("반복 주기 및 횟수");
    expect(html).toContain("1회 소요 시간 (분)");
    expect(html).toContain("업무 비교하기");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("선택 결과 보기");
    expect(html).not.toContain("Windows PowerShell");
    expect(html).not.toContain("가상 터미널");
    expect(html).not.toContain('value="주간 보고서 취합"');
  });

  test("나머지 작성형 실습은 각 안내에 대응하는 빈 작성란을 제공한다", () => {
    for (const content of allContents()) {
      for (const unit of content.units.filter((unit) => unit.practice && practiceInputKind(unit) === "writing")) {
        const html = renderToStaticMarkup(createElement(WritingPractice, { steps: unit.practice!.steps }));
        expect(html.match(/<textarea/g), unit.id).toHaveLength(unit.practice!.steps.length);
        expect(html, unit.id).toContain("자동 실행이나 정답 판정은 하지 않습니다");
        expect(html, unit.id).toContain("<strong>실습 방법:</strong> 각 안내에 맞춰");
        expect(html, unit.id).not.toContain("Windows PowerShell");
        expect(html, unit.id).not.toContain("가상 터미널");
      }
    }
  });

  test("단위 이동은 작성 상태를 초기화하고 터미널 저장 연결은 유지한다", () => {
    const source = readFileSync(new URL("../src/components/learn/LearnLesson.tsx", import.meta.url), "utf8");
    expect(source).toContain("<RepetitiveJobsPractice key={unit.id} />");
    expect(source).toContain("<WritingPractice key={unit.id} steps={unit.practice.steps} />");
    expect(source).toContain("initialSnapshot={practiceStates[stateKey] ?? null}");
    expect(source).toContain("onSnapshotChange={(snapshot) => onPracticeStateChange(stateKey, snapshot)}");
    expect(source).toContain("실습: ${unit.practice.title}");
    expect(source).not.toContain("실습 —");
    expect(source).toContain('unitId === "l5-u1" ? "folder-nav"');
    expect(source).toContain("<strong>실습:</strong> {unit.practice.title}");
    expect(source).toContain("<strong>실행 환경:</strong> Windows PowerShell");
    expect(source).toContain("<strong>연습 모드:</strong> 작성형 연습이며, 점수에 반영되지 않습니다.");
    expect(source).toContain("<strong>{unit.concepts[0].term}:</strong> {unit.concepts[0].definition}");
    expect(source).toContain("<strong>{c.title}:</strong> {c.situation}");
    expect(source).not.toMatch(/<h5>(실행 환경|연습 모드|실습 방법)<\/h5>/);
    expect(source).toContain('<ol className="learn-practice-steps">');
    const practiceSource = readFileSync(new URL("../src/components/learn/LearnPractice.tsx", import.meta.url), "utf8");
    expect(practiceSource).toContain("<strong>선택한 자동화 후보:</strong> {normalizeJobName(jobs[candidate].name)}");
    expect(practiceSource).toContain("<strong>업무 비교:</strong> 한 달을 30일로 환산한 예상 업무량입니다.");
  });
});
