import { describe, expect, test } from "vitest";
import {
  checkTerminalSuccess,
  createInitialState,
  executeCommand,
  initialStateForScenario,
  scenarioGitBasic,
  scenarioGitRemote,
} from "@/lib/learn/terminal";

describe("기본 명령어", () => {
  test("mkdir + cd + pwd", () => {
    let s = createInitialState();
    let r = executeCommand(s, "mkdir WorkLens");
    expect(r.output.join("\n")).not.toContain("이미 있습니다");
    s = r.state;
    r = executeCommand(s, "cd WorkLens");
    s = r.state;
    r = executeCommand(s, "pwd");
    expect(r.output[0]).toBe("C:\\Users\\학습자\\WorkLens");
  });
  test("존재하지 않는 경로 이동 시 오류", () => {
    const s = createInitialState();
    const r = executeCommand(s, "cd 없는폴더");
    expect(r.output.join("\n")).toContain("찾을 수 없습니다");
    expect(r.state.cwd).toBe(s.cwd); // 이동하지 않음
  });
  test("cd .. 상위 이동", () => {
    let s = createInitialState();
    s = executeCommand(s, "mkdir a").state;
    s = executeCommand(s, "cd a").state;
    s = executeCommand(s, "cd ..").state;
    expect(s.cwd).toBe("C:\\Users\\학습자");
  });
  test("공백 포함 경로 따옴표 처리", () => {
    let s = createInitialState();
    s = executeCommand(s, 'mkdir "내 문서"').state;
    const r = executeCommand(s, 'cd "내 문서"');
    expect(r.state.cwd).toBe("C:\\Users\\학습자\\내 문서");
  });
  test("dir 목록", () => {
    let s = createInitialState();
    s = executeCommand(s, "mkdir WorkLens").state;
    const r = executeCommand(s, "dir");
    expect(r.output.join("\n")).toContain("WorkLens");
  });
  test("지원하지 않는 명령 안내", () => {
    const s = createInitialState();
    const r = executeCommand(s, "rm -rf /");
    expect(r.output.join("\n")).toContain("지원하지 않는 명령");
  });
  test("실제 셸 실행 없음 — 위험 명령도 시뮬레이션", () => {
    const s = createInitialState();
    const r = executeCommand(s, "format C:");
    expect(r.state.dirs.has("C:\\Users\\학습자")).toBe(true); // 상태 불변
  });
});

describe("Git 기본 작업", () => {
  test("status → add → commit → push 흐름", () => {
    let s = scenarioGitBasic();
    let r = executeCommand(s, "git status");
    expect(r.output.join("\n")).toContain("report.txt");
    s = r.state;
    s = executeCommand(s, "git add report.txt").state;
    expect(s.git.staged).toContain("report.txt");
    s = executeCommand(s, 'git commit -m "보고서 수정"').state;
    expect(s.git.commits.length).toBe(1);
    expect(s.git.ahead).toBe(1);
    // 원격이 없으므로 push 실패
    r = executeCommand(s, "git push");
    expect(r.output.join("\n")).toContain("원격 저장소가 설정되어 있지 않습니다");
  });
  test("스테이징 없이 커밋 시 오류", () => {
    let s = scenarioGitBasic();
    s = executeCommand(s, "git add report.txt").state;
    s = executeCommand(s, 'git commit -m "수정"').state;
    const r = executeCommand(s, 'git commit -m "빈 커밋"');
    expect(r.output.join("\n")).toContain("커밋할 변경 사항이 없습니다");
  });
  test("Git 저장소가 아닌 위치에서 git 명령", () => {
    const s = createInitialState();
    const r = executeCommand(s, "git status");
    expect(r.output.join("\n")).toContain("Git 저장소가 아닙니다");
  });
});

describe("원격 저장소", () => {
  test("clone → pull 흐름", () => {
    let s = createInitialState();
    s = executeCommand(s, "git clone https://github.com/example/repo.git").state;
    expect(s.cwd).toBe("C:\\Users\\학습자\\repo");
    expect(s.git.remote).not.toBeNull();
    const r = executeCommand(s, "git pull");
    expect(r.output.join("\n")).toContain("이미 최신 상태입니다");
  });
  test("behind 상태에서 push 거부 → pull 후 push", () => {
    let s = scenarioGitRemote();
    // 로컬 커밋을 만들기 위해 파일 변경
    s = executeCommand(s, 'echo "추가" > note.txt').state;
    s = executeCommand(s, "git add note.txt").state;
    s = executeCommand(s, 'git commit -m "메모 추가"').state;
    let r = executeCommand(s, "git push");
    expect(r.output.join("\n")).toContain("거부되었습니다");
    s = r.state;
    s = executeCommand(s, "git pull").state;
    expect(s.git.behind).toBe(0);
    r = executeCommand(s, "git push");
    expect(r.output.join("\n")).toContain("푸시 완료");
  });
});

describe("성공 조건 검사", () => {
  test("폴더 생성·이동 과제", () => {
    let s = initialStateForScenario("folder-nav");
    s = executeCommand(s, "mkdir WorkLens").state;
    s = executeCommand(s, "cd WorkLens").state;
    const { passed } = checkTerminalSuccess(s, [
      { kind: "dir-exists", path: "C:\\Users\\학습자\\WorkLens" },
      { kind: "cwd-is", path: "C:\\Users\\학습자\\WorkLens" },
    ]);
    expect(passed).toBe(true);
  });
  test("조건 미달 시 실패", () => {
    const s = initialStateForScenario("folder-nav");
    const { passed, detail } = checkTerminalSuccess(s, [
      { kind: "dir-exists", path: "C:\\Users\\학습자\\WorkLens" },
    ]);
    expect(passed).toBe(false);
    expect(detail[0].ok).toBe(false);
  });
  test("커밋 과제", () => {
    let s = scenarioGitBasic();
    s = executeCommand(s, "git add .").state;
    s = executeCommand(s, 'git commit -m "전체 반영"').state;
    const { passed } = checkTerminalSuccess(s, [{ kind: "commit-exists", messageContains: "전체 반영" }]);
    expect(passed).toBe(true);
  });
});
