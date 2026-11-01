import { describe, expect, test } from "vitest";
import {
  checkTerminalSuccess,
  createInitialState,
  deserializeTerminalState,
  executeCommand,
  initialStateForScenario,
  scenarioGitBasic,
  scenarioGitRemote,
  serializeTerminalState,
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
  test("PowerShell 표기: mkdir은 만든 폴더 정보를, dir은 Mode d-----를 표시한다", () => {
    let s = createInitialState();
    const mk = executeCommand(s, "mkdir WorkLens");
    expect(mk.output.join("\n")).toContain("d-----");
    expect(mk.output.join("\n")).toContain("WorkLens");
    s = mk.state;
    const r = executeCommand(s, "dir");
    expect(r.output.join("\n")).toContain("d-----  WorkLens");
    expect(r.output.join("\n")).not.toContain("<DIR>");
  });
  test("cd 무인자는 홈 디렉터리로 이동한다 (실제 PowerShell 동작)", () => {
    let s = createInitialState();
    s = executeCommand(s, "mkdir a").state;
    s = executeCommand(s, "cd a").state;
    const r = executeCommand(s, "cd");
    expect(r.state.cwd).toBe("C:\\Users\\학습자");
  });
  test("cd \\ 는 드라이브 루트로 이동한다", () => {
    let s = createInitialState();
    s = executeCommand(s, "mkdir a").state;
    s = executeCommand(s, "cd a").state;
    const r = executeCommand(s, "cd \\");
    expect(r.state.cwd).toBe("C:\\");
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
  test("clone은 현재 위치를 유지하며 cd 후 저장소 명령을 실행한다", () => {
    let s = createInitialState();
    s = executeCommand(s, "git clone https://github.com/example/repo.git").state;
    expect(s.cwd).toBe("C:\\Users\\학습자");
    expect(s.git.remote).not.toBeNull();
    expect(executeCommand(s, "git log").output.join("\n")).toContain("Git 저장소가 아닙니다");
    s = executeCommand(s, "cd repo").state;
    expect(s.cwd).toBe("C:\\Users\\학습자\\repo");
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

describe("안내된 CLI·Git 흐름 회귀", () => {
  test.each(['mkdir "내 문서', "mkdir '내 문서"])("닫히지 않은 따옴표를 거부한다: %s", (command) => {
    const s = createInitialState();
    const r = executeCommand(s, command);
    expect(r.output.join("\n")).toContain("따옴표가 닫히지 않았습니다");
    expect([...r.state.dirs]).toEqual([...s.dirs]);
  });

  test("공백 경로의 따옴표 누락은 첫 단어 폴더가 있어도 이동하지 않는다", () => {
    let s = executeCommand(createInitialState(), "mkdir 내").state;
    s = executeCommand(s, 'mkdir "내 문서"').state;
    const failed = executeCommand(s, "cd 내 문서");
    expect(failed.state.cwd).toBe(s.cwd);
    expect(failed.output.join("\n")).toContain("따옴표");
    const recovered = executeCommand(failed.state, 'cd "내 문서"');
    expect(recovered.state.cwd).toBe("C:\\Users\\학습자\\내 문서");
  });

  test("LEVEL 4 오류 → 목록 확인 → 따옴표 경로 복구", () => {
    let s = initialStateForScenario("failure");
    const failed = executeCommand(s, "cd 문서보고서");
    expect(failed.output.join("\n")).toContain("찾을 수 없습니다");
    s = failed.state;
    expect(executeCommand(s, "dir").output).toEqual(["(비어 있음)"]);
    expect(executeCommand(s, "help").output.join("\n")).toContain("mkdir");
    s = executeCommand(s, 'mkdir "내 문서"').state;
    expect(executeCommand(s, "ls").output).toEqual(executeCommand(s, "dir").output);
    s = executeCommand(s, 'cd "내 문서"').state;
    expect(executeCommand(s, "Get-Location").output).toEqual(executeCommand(s, "pwd").output);
    expect(checkTerminalSuccess(s, [
      { kind: "dir-exists", path: "C:\\Users\\학습자\\내 문서" },
      { kind: "cwd-is", path: "C:\\Users\\학습자\\내 문서" },
    ]).passed).toBe(true);
  });

  test("LEVEL 5 clone → cd → dir → log 안내 순서", () => {
    let s = initialStateForScenario("folder-nav");
    s = executeCommand(s, "git clone https://github.com/example/team-docs.git").state;
    expect(s.cwd).toBe("C:\\Users\\학습자");
    expect(executeCommand(s, "dir").output.join("\n")).toContain("d-----  team-docs");
    s = executeCommand(s, "cd team-docs").state;
    expect(executeCommand(s, "dir").output.join("\n")).toContain("-a----  README.md");
    expect(executeCommand(s, "git log").output.join("\n")).toContain("초기 커밋");
  });

  test("LEVEL 5 저장소 밖 오류 → clone → cd → log 복구", () => {
    let s = initialStateForScenario("git-basic");
    s = executeCommand(s, "cd ..").state;
    expect(executeCommand(s, "git status").output.join("\n")).toContain("Git 저장소가 아닙니다");
    s = executeCommand(s, "git clone https://github.com/example/team-docs.git").state;
    s = executeCommand(s, "cd team-docs").state;
    expect(s.cwd).toBe("C:\\Users\\학습자\\team-docs");
    expect(executeCommand(s, "git log").output.join("\n")).toContain("초기 커밋");
  });

  test("기존 clone 경로를 덮어쓰거나 커밋을 지우지 않는다", () => {
    let s = executeCommand(createInitialState(), "git clone https://github.com/example/team-docs.git").state;
    s = executeCommand(s, "cd team-docs").state;
    s = executeCommand(s, 'echo "메모" > note.txt').state;
    s = executeCommand(s, "git add note.txt").state;
    s = executeCommand(s, 'git commit -m "메모 추가"').state;
    s = executeCommand(s, "cd ..").state;
    const r = executeCommand(s, "git clone https://github.com/example/team-docs.git");
    expect(r.output.join("\n")).toContain("이미 있습니다");
    expect(r.state.git).toEqual(s.git);
    expect([...r.state.files]).toEqual([...s.files]);
  });

  test("git add는 잘못된 디렉터리의 같은 파일명에 반응하지 않는다", () => {
    const s = scenarioGitBasic();
    const r = executeCommand(s, "git add missing/report.txt");
    expect(r.output.join("\n")).toContain("변경 사항이 없습니다");
    expect(r.state.git.staged).toEqual([]);
    expect(r.state.git.modified).toEqual(["report.txt"]);
    const recovered = executeCommand(r.state, "git add .\\report.txt");
    expect(recovered.state.git.staged).toEqual(["report.txt"]);
    expect(recovered.state.git.untracked).toEqual(["memo.txt"]);
  });

  test("하위 폴더에서 git add . 는 그 폴더의 변경만 선택한다", () => {
    let s = scenarioGitBasic();
    s = executeCommand(s, "mkdir docs").state;
    s = executeCommand(s, "cd docs").state;
    s = executeCommand(s, 'echo "메모" > note.txt').state;
    s = executeCommand(s, "git add .").state;
    expect(s.git.staged).toEqual(["docs\\note.txt"]);
    expect(s.git.modified).toEqual(["report.txt"]);
    expect(s.git.untracked).toEqual(["memo.txt"]);
  });

  test("LEVEL 5 pull 완료와 push 거부 상태를 구분한다", () => {
    let s = scenarioGitRemote();
    expect(checkTerminalSuccess(s, [{ kind: "remote-in-sync" }]).passed).toBe(false);
    const rejected = executeCommand(s, "git push");
    expect(rejected.output.join("\n")).toContain("거부되었습니다");
    expect(rejected.state.git.behind).toBe(1);
    s = executeCommand(rejected.state, "git pull").state;
    expect(checkTerminalSuccess(s, [{ kind: "remote-in-sync" }]).passed).toBe(true);
    expect(executeCommand(s, "git status").output.join("\n")).toContain("최신 상태");
    expect(executeCommand(s, "git push").output.join("\n")).toContain("푸시할 내용이 없습니다");
  });

  test("빈 메시지와 닫히지 않은 메시지로 커밋이 생성되지 않는다", () => {
    let s = executeCommand(scenarioGitBasic(), "git add report.txt").state;
    for (const command of ['git commit -m ""', 'git commit -m "보고서 수정']) {
      const r = executeCommand(s, command);
      expect(r.state.git.commits).toEqual([]);
      expect(r.state.git.staged).toEqual(["report.txt"]);
      s = r.state;
    }
    s = executeCommand(s, 'git commit -m "보고서 수정"').state;
    expect(s.git.commits).toHaveLength(1);
    expect(s.git.untracked).toEqual(["memo.txt"]);
    expect(executeCommand(s, 'git commit -m "빈 커밋"').output.join("\n")).toContain("커밋할 변경 사항이 없습니다");
  });

  test("완료 조건은 다른 경로의 같은 파일명과 없는 파일을 통과시키지 않는다", () => {
    const s = executeCommand(scenarioGitBasic(), "git add report.txt").state;
    expect(checkTerminalSuccess(s, [{ kind: "staged-includes", path: "missing/report.txt" }]).passed).toBe(false);
    expect(checkTerminalSuccess(s, [{ kind: "staged-includes", path: "./report.txt" }]).passed).toBe(true);
    expect(checkTerminalSuccess(s, [{ kind: "file-contains", path: "없는파일.txt", text: "" }]).passed).toBe(false);
  });

  test("충돌 상태는 원격 동기화 완료로 판정하지 않는다", () => {
    const s = scenarioGitRemote();
    s.git.behind = 0;
    s.git.conflicted = true;
    expect(checkTerminalSuccess(s, [{ kind: "remote-in-sync" }]).passed).toBe(false);
    expect(executeCommand(s, "git pull").output.join("\n")).toContain("충돌");
    expect(executeCommand(s, "git push").output.join("\n")).toContain("충돌");
  });
});

describe("터미널 명령 실행 경로 기록", () => {
  test("이동 전 명령 경로가 현재 경로와 분리되어 저장·복원된다", () => {
    const initial = createInitialState();
    const created = executeCommand(initial, "mkdir WorkLens").state;
    const moved = executeCommand(created, "cd WorkLens").state;
    const transcript = [
      { cmd: "mkdir WorkLens", out: [], cwd: initial.cwd },
      { cmd: "cd WorkLens", out: [], cwd: created.cwd },
    ];
    const restored = deserializeTerminalState(serializeTerminalState(moved, transcript))!;
    expect(restored.state.cwd).toBe("C:\\Users\\학습자\\WorkLens");
    expect(restored.transcript).toEqual(transcript);
    expect(restored.transcript[0].cwd).toBe("C:\\Users\\학습자");
  });

  test("실행 경로가 없는 과거 기록도 그대로 복원한다", () => {
    const transcript = [{ cmd: "pwd", out: ["C:\\Users\\학습자"] }];
    expect(deserializeTerminalState(serializeTerminalState(createInitialState(), transcript))!.transcript).toEqual(transcript);
  });
});
