/**
 * CLI·Git 가상 터미널 시뮬레이터
 *
 * - 실제 운영체제 셸 명령을 실행하지 않는다.
 * - 허용된 명령어만 해석하며, 가상 파일·Git 상태를 관리한다.
 * - 기본 학습 환경은 Windows PowerShell이다.
 */

import type { TerminalStateSnapshot, TerminalSuccessCheck, TerminalTaskSpec } from "./types";

export interface VirtualGitState {
  repoRoot: string | null;
  branch: string;
  branches: string[];
  staged: string[];
  modified: string[];
  untracked: string[];
  commits: { id: string; message: string }[];
  remote: { name: string; url: string } | null;
  ahead: number;
  behind: number;
  conflicted: boolean;
}

export interface VirtualTerminalState {
  cwd: string;
  dirs: Set<string>;
  files: Map<string, string>;
  git: VirtualGitState;
  /** 명령어 실행 결과 줄 (화면 표시용) */
  lines: string[];
}

const ROOT = "C:\\Users\\학습자";

function normalizePath(cwd: string, raw: string): string {
  let p = raw.trim().replace(/\//g, "\\");
  if (/^[A-Za-z]:\\/.test(p)) {
    // 절대 경로
  } else if (p.startsWith("\\")) {
    // 드라이브 루트 기준 경로 (예: cd \)
    p = `${cwd.slice(0, 2)}${p}`;
  } else if (p === "..") {
    p = parentDir(cwd);
  } else if (p === "." || p === "") {
    p = cwd;
  } else {
    p = `${cwd}\\${p}`;
  }
  // ".." 세그먼트 정리
  const parts = p.split("\\");
  const drive = parts.shift()!;
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  return `${drive}\\${stack.join("\\")}`;
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("\\");
  return idx <= 2 ? p.slice(0, 3) : p.slice(0, idx);
}

function baseName(p: string): string {
  const normalized = p.replace(/\//g, "\\");
  const idx = normalized.lastIndexOf("\\");
  return normalized.slice(idx + 1);
}

function isInsideRepo(state: VirtualTerminalState): boolean {
  return state.git.repoRoot !== null && (state.cwd === state.git.repoRoot || state.cwd.startsWith(state.git.repoRoot + "\\"));
}

function newGitState(): VirtualGitState {
  return { repoRoot: null, branch: "main", branches: ["main"], staged: [], modified: [], untracked: [], commits: [], remote: null, ahead: 0, behind: 0, conflicted: false };
}

/** 명령어 토큰화 — 따옴표 안 공백 유지 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) { tokens.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function createInitialState(): VirtualTerminalState {
  return {
    cwd: ROOT,
    dirs: new Set([ROOT]),
    files: new Map(),
    git: newGitState(),
    lines: [],
  };
}

/** 시나리오 A: 폴더 생성·이동 실습용 빈 상태 */
export function scenarioFolderNav(): VirtualTerminalState {
  const s = createInitialState();
  s.lines.push("Windows PowerShell", "가상 실습 환경입니다. 실제 컴퓨터에는 영향을 주지 않습니다.", "");
  return s;
}

/** 시나리오 B: Git 기본 작업 — 변경된 파일이 있는 저장소 */
export function scenarioGitBasic(): VirtualTerminalState {
  const s = createInitialState();
  const repo = `${ROOT}\\my-project`;
  s.dirs.add(repo);
  s.files.set(`${repo}\\README.md`, "# my-project");
  s.files.set(`${repo}\\report.txt`, "월간 보고서 초안");
  s.cwd = repo;
  s.git = { ...newGitState(), repoRoot: repo, modified: ["report.txt"], untracked: ["memo.txt"] };
  s.files.set(`${repo}\\memo.txt`, "회의 메모");
  s.lines.push("가상 저장소 'my-project'가 준비되었습니다. git status로 상태를 확인해 보세요.", "");
  return s;
}

/** 시나리오 C: 원격 저장소 작업 — clone된 상태 */
export function scenarioGitRemote(): VirtualTerminalState {
  const s = createInitialState();
  const repo = `${ROOT}\\team-docs`;
  s.dirs.add(repo);
  s.files.set(`${repo}\\guide.md`, "# 팀 문서");
  s.cwd = repo;
  s.git = {
    ...newGitState(),
    repoRoot: repo,
    remote: { name: "origin", url: "https://github.com/example/team-docs.git" },
    commits: [{ id: "a1b2c3d", message: "초기 문서 추가" }],
    behind: 1, // 원격에 새 커밋이 있음
  };
  s.lines.push("원격 저장소를 clone했습니다. git log와 git pull을 실행해 보세요.", "");
  return s;
}

/** 시나리오 D: 실패 상황 학습용 */
export function scenarioFailure(): VirtualTerminalState {
  return scenarioFolderNav();
}

export interface ExecResult {
  state: VirtualTerminalState;
  output: string[];
}

/** 명령어 실행 — 실제 셸을 호출하지 않음 */
export function executeCommand(prev: VirtualTerminalState, input: string): ExecResult {
  const state: VirtualTerminalState = {
    cwd: prev.cwd,
    dirs: new Set(prev.dirs),
    files: new Map(prev.files),
    git: { ...prev.git, staged: [...prev.git.staged], modified: [...prev.git.modified], untracked: [...prev.git.untracked], commits: [...prev.git.commits], branches: [...prev.git.branches] },
    lines: [],
  };
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  const tokens = tokenize(input);
  if (tokens.length === 0) return { state, output: [] };
  const [cmd, ...args] = tokens;
  const lower = cmd.toLowerCase();

  // ---- 기본 명령어 ----
  if (lower === "help") {
    push("사용 가능한 명령: mkdir, cd, dir, ls, pwd, Get-Location, echo, git, help, clear");
    return { state, output: out };
  }
  if (lower === "clear") {
    state.lines = [];
    return { state, output: [] };
  }
  if (lower === "mkdir") {
    if (!args[0]) { push("mkdir: 폴더 이름을 입력하세요. 예) mkdir WorkLens"); return { state, output: out }; }
    const target = normalizePath(state.cwd, args[0]);
    if (state.dirs.has(target) || state.files.has(target)) { push(`mkdir: '${args[0]}'이(가) 이미 있습니다.`); return { state, output: out }; }
    state.dirs.add(target);
    // 실제 PowerShell의 mkdir은 만든 폴더 정보를 표시한다
    push(`d-----  ${baseName(target)}`);
    return { state, output: out };
  }
  if (lower === "cd") {
    // 실제 PowerShell의 cd는 경로를 생략하면 홈 디렉터리로 이동한다
    if (!args[0]) { state.cwd = ROOT; return { state, output: out }; }
    const target = normalizePath(state.cwd, args[0]);
    // 알려진 폴더의 상위 경로는 실제 파일 시스템처럼 존재하는 것으로 취급한다
    const prefix = target.endsWith("\\") ? target : `${target}\\`;
    const exists = state.dirs.has(target) || [...state.dirs].some((d) => d.startsWith(prefix));
    if (!exists) { push(`cd: '${args[0]}' 경로를 찾을 수 없습니다. dir로 폴더 목록을 확인하세요.`); return { state, output: out }; }
    state.cwd = target;
    return { state, output: out };
  }
  if (lower === "dir" || lower === "ls") {
    const entries: string[] = [];
    for (const d of state.dirs) {
      if (parentDir(d) === state.cwd && d !== state.cwd) entries.push(`d-----  ${baseName(d)}`);
    }
    for (const [f] of state.files) {
      if (parentDir(f) === state.cwd) entries.push(`       ${baseName(f)}`);
    }
    if (entries.length === 0) push("(비어 있음)");
    else push(...entries.sort());
    return { state, output: out };
  }
  if (lower === "pwd" || lower === "get-location") {
    push(state.cwd);
    return { state, output: out };
  }
  if (lower === "echo") {
    // echo 텍스트 > 파일 — 파일 생성/수정용
    const redirectIdx = tokens.findIndex((t) => t === ">" || t === ">>");
    if (redirectIdx === -1) { push(args.join(" ")); return { state, output: out }; }
    const text = tokens.slice(1, redirectIdx).join(" ");
    const fileName = tokens[redirectIdx + 1];
    if (!fileName) { push("echo: '>' 뒤에 파일 이름을 입력하세요."); return { state, output: out }; }
    const target = normalizePath(state.cwd, fileName);
    if (!state.dirs.has(parentDir(target))) { push(`echo: '${fileName}'의 폴더가 없습니다.`); return { state, output: out }; }
    state.files.set(target, text);
    if (isInsideRepo(state)) {
      const rel = target.slice(state.git.repoRoot!.length + 1);
      if (!state.git.staged.includes(rel) && !state.git.modified.includes(rel)) state.git.modified.push(rel);
      state.git.untracked = state.git.untracked.filter((u) => u !== rel);
    }
    return { state, output: out };
  }

  // ---- git ----
  if (lower === "git") {
    return execGit(state, args, out);
  }

  push(`'${cmd}'은(는) 이 실습에서 지원하지 않는 명령입니다. help를 입력해 보세요.`);
  return { state, output: out };
}

function execGit(state: VirtualTerminalState, args: string[], out: string[]): ExecResult {
  const push = (...lines: string[]) => out.push(...lines);
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "clone") {
    const url = args[1];
    if (!url) { push("git clone: 저장소 주소를 입력하세요. 예) git clone https://github.com/example/repo.git"); return { state, output: out }; }
    const name = baseName(url).replace(/\.git$/, "") || "repo";
    const target = normalizePath(state.cwd, name);
    state.dirs.add(target);
    state.files.set(`${target}\\README.md`, "# " + name);
    state.cwd = target;
    state.git = { ...newGitState(), repoRoot: target, remote: { name: "origin", url }, commits: [{ id: "a1b2c3d", message: "초기 커밋" }] };
    push(`'${url}'을(를) '${name}' 폴더에 복제했습니다.`);
    return { state, output: out };
  }

  if (!isInsideRepo(state)) {
    push("git: Git 저장소가 아닙니다. git clone으로 저장소를 가져오거나, 저장소 폴더에서 실행하세요.");
    return { state, output: out };
  }
  const g = state.git;

  if (sub === "status") {
    push(`On branch ${g.branch}`);
    if (g.conflicted) { push("충돌이 발생했습니다. 파일을 수정한 뒤 git add 하세요."); }
    if (g.staged.length > 0) { push("커밋할 변경 사항:", ...g.staged.map((f) => `  staged: ${f}`)); }
    if (g.modified.length > 0) { push("커밋을 위해 스테이지되지 않은 변경 사항:", ...g.modified.map((f) => `  modified: ${f}`)); }
    if (g.untracked.length > 0) { push("추적하지 않는 파일:", ...g.untracked.map((f) => `  ${f}`)); }
    if (g.staged.length === 0 && g.modified.length === 0 && g.untracked.length === 0) push("작업 트리가 깨끗합니다.");
    if (g.ahead > 0) push(`원격 저장소보다 ${g.ahead}개 커밋 앞서 있습니다. (git push 필요)`);
    if (g.behind > 0) push(`원격 저장소보다 ${g.behind}개 커밋 뒤처져 있습니다. (git pull 필요)`);
    return { state, output: out };
  }
  if (sub === "add") {
    const target = args[1];
    if (!target) { push("git add: 파일 이름을 입력하세요. 예) git add report.txt  또는  git add ."); return { state, output: out }; }
    if (target === ".") {
      g.staged.push(...g.modified, ...g.untracked);
      g.modified = []; g.untracked = [];
      push("모든 변경 사항을 스테이징했습니다.");
    } else {
      const name = target.replace(/\\/g, "/");
      const idx = g.modified.findIndex((m) => m.replace(/\\/g, "/") === name || baseName(m) === baseName(name));
      const uidx = g.untracked.findIndex((m) => m.replace(/\\/g, "/") === name || baseName(m) === baseName(name));
      if (idx >= 0) { g.staged.push(g.modified[idx]); g.modified.splice(idx, 1); push(`'${target}'을(를) 스테이징했습니다.`); }
      else if (uidx >= 0) { g.staged.push(g.untracked[uidx]); g.untracked.splice(uidx, 1); push(`'${target}'을(를) 스테이징했습니다.`); }
      else push(`git add: '${target}'에 해당하는 변경 사항이 없습니다. git status로 확인하세요.`);
    }
    return { state, output: out };
  }
  if (sub === "commit") {
    const mIdx = args.findIndex((a) => a === "-m" || a === "--message");
    const message = mIdx >= 0 ? args[mIdx + 1] : undefined;
    if (g.staged.length === 0) { push("git commit: 커밋할 변경 사항이 없습니다. 먼저 git add로 스테이징하세요."); return { state, output: out }; }
    if (!message) { push('git commit: 메시지를 입력하세요. 예) git commit -m "보고서 수정"'); return { state, output: out }; }
    const id = Math.random().toString(16).slice(2, 8);
    g.commits.push({ id, message });
    g.staged = [];
    g.ahead += 1;
    push(`[${g.branch} ${id}] ${message}`);
    return { state, output: out };
  }
  if (sub === "push") {
    if (!g.remote) { push("git push: 원격 저장소가 설정되어 있지 않습니다. (fatal: No configured push destination)"); return { state, output: out }; }
    if (g.behind > 0) { push("git push: 거부되었습니다. 원격 저장소에 새 변경 사항이 있습니다. 먼저 git pull을 실행하세요."); return { state, output: out }; }
    if (g.ahead === 0) { push("git push: 푸시할 내용이 없습니다. (Everything up-to-date)"); return { state, output: out }; }
    g.ahead = 0;
    push(`To ${g.remote.url}`, `   ${g.branch} -> ${g.branch} (푸시 완료)`);
    return { state, output: out };
  }
  if (sub === "pull") {
    if (!g.remote) { push("git pull: 원격 저장소가 설정되어 있지 않습니다."); return { state, output: out }; }
    if (g.conflicted) { push("git pull: 충돌이 있습니다. 충돌 파일을 수정하고 git add 하세요."); return { state, output: out }; }
    if (g.behind === 0) { push("이미 최신 상태입니다."); return { state, output: out }; }
    g.behind = 0;
    g.commits.push({ id: Math.random().toString(16).slice(2, 8), message: "원격 변경 사항 병합" });
    push(`From ${g.remote.url}`, " * branch            main       -> FETCH_HEAD", "병합 완료: 원격 변경 사항을 가져왔습니다.");
    return { state, output: out };
  }
  if (sub === "branch") {
    if (args[1]) {
      if (g.branches.includes(args[1])) { push(`git branch: '${args[1]}' 브랜치가 이미 있습니다.`); }
      else { g.branches.push(args[1]); push(`브랜치 '${args[1]}'을(를) 만들었습니다.`); }
    } else {
      push(...g.branches.map((b) => (b === g.branch ? `* ${b}` : `  ${b}`)));
    }
    return { state, output: out };
  }
  if (sub === "switch" || sub === "checkout") {
    const name = args[1];
    if (!name) { push(`git ${sub}: 브랜치 이름을 입력하세요.`); return { state, output: out }; }
    if (!g.branches.includes(name)) { push(`git ${sub}: '${name}' 브랜치가 없습니다. git branch로 확인하세요.`); return { state, output: out }; }
    g.branch = name;
    push(`'${name}' 브랜치로 전환했습니다.`);
    return { state, output: out };
  }
  if (sub === "log") {
    if (g.commits.length === 0) push("(커밋 없음)");
    else push(...[...g.commits].reverse().map((c) => `commit ${c.id}\n    ${c.message}`));
    return { state, output: out };
  }
  if (sub === "diff") {
    if (g.modified.length === 0 && g.staged.length === 0) push("(변경 사항 없음)");
    else push(...g.modified.map((f) => `--- ${f} (수정됨)`), ...g.staged.map((f) => `--- ${f} (스테이지됨)`));
    return { state, output: out };
  }
  push(`git ${sub || ""}: 이 실습에서 지원하지 않는 git 하위 명령입니다. (status, add, commit, push, pull, branch, switch, log, diff, clone 지원)`);
  return { state, output: out };
}

/** 성공 조건 검사 */
export function checkTerminalSuccess(state: VirtualTerminalState, checks: TerminalSuccessCheck[]): { passed: boolean; detail: { check: TerminalSuccessCheck; ok: boolean }[] } {
  const detail = checks.map((check) => ({ check, ok: evalCheck(state, check) }));
  return { passed: detail.every((d) => d.ok), detail };
}

function evalCheck(state: VirtualTerminalState, check: TerminalSuccessCheck): boolean {
  const g = state.git;
  switch (check.kind) {
    case "cwd-is":
      return state.cwd.toLowerCase() === check.path.toLowerCase();
    case "dir-exists":
      return state.dirs.has(check.path);
    case "file-exists":
      return state.files.has(check.path);
    case "file-contains":
      return (state.files.get(check.path) ?? "").includes(check.text);
    case "staged-includes":
      return g.staged.some((s) => s === check.path || baseName(s) === baseName(check.path));
    case "commit-exists":
      return g.commits.some((c) => c.message.includes(check.messageContains));
    case "branch-is":
      return g.branch === check.name;
    case "remote-in-sync":
      return g.remote !== null && g.ahead === 0 && g.behind === 0;
  }
}

/**
 * 터미널 상태를 저장 가능한 스냅샷으로 직렬화한다.
 * Set/Map을 배열로 풀어 JSON 저장이 가능하게 한다.
 */
export function serializeTerminalState(
  state: VirtualTerminalState,
  transcript: { cmd: string; out: string[] }[],
): TerminalStateSnapshot {
  return {
    cwd: state.cwd,
    dirs: [...state.dirs],
    files: [...state.files.entries()],
    git: {
      repoRoot: state.git.repoRoot,
      branch: state.git.branch,
      branches: [...state.git.branches],
      staged: [...state.git.staged],
      modified: [...state.git.modified],
      untracked: [...state.git.untracked],
      commits: state.git.commits.map((c) => ({ ...c })),
      remote: state.git.remote ? { ...state.git.remote } : null,
      ahead: state.git.ahead,
      behind: state.git.behind,
      conflicted: state.git.conflicted,
    },
    lines: [...state.lines],
    transcript: transcript.map((t) => ({ cmd: t.cmd, out: [...t.out] })),
  };
}

/** 스냅샷 구조 검증 — 손상된 스냅샷은 복원 대상으로 취급하지 않는다 */
export function isValidTerminalSnapshot(value: unknown): value is TerminalStateSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const git = s.git as Record<string, unknown> | null;
  return (
    typeof s.cwd === "string" &&
    Array.isArray(s.dirs) && s.dirs.every((d) => typeof d === "string") &&
    Array.isArray(s.files) &&
    s.files.every((f) => Array.isArray(f) && typeof f[0] === "string" && typeof f[1] === "string") &&
    typeof git === "object" && git !== null &&
    (git.repoRoot === null || typeof git.repoRoot === "string") &&
    typeof git.branch === "string" &&
    Array.isArray(git.branches) && Array.isArray(git.staged) && Array.isArray(git.modified) &&
    Array.isArray(git.untracked) && Array.isArray(git.commits) &&
    typeof git.ahead === "number" && typeof git.behind === "number" &&
    Array.isArray(s.transcript)
  );
}

/** 스냅샷에서 터미널 상태를 복원한다. 구조가 손상되었으면 null을 반환한다. */
export function deserializeTerminalState(
  snapshot: TerminalStateSnapshot,
): { state: VirtualTerminalState; transcript: { cmd: string; out: string[] }[] } | null {
  if (!isValidTerminalSnapshot(snapshot)) return null;
  const g = snapshot.git;
  const state: VirtualTerminalState = {
    cwd: snapshot.cwd,
    dirs: new Set(snapshot.dirs),
    files: new Map(snapshot.files),
    git: {
      repoRoot: g.repoRoot,
      branch: g.branch,
      branches: [...g.branches],
      staged: [...g.staged],
      modified: [...g.modified],
      untracked: [...g.untracked],
      commits: g.commits.map((c) => ({ id: String(c.id), message: String(c.message) })),
      remote: g.remote ? { name: String(g.remote.name), url: String(g.remote.url) } : null,
      ahead: g.ahead,
      behind: g.behind,
      conflicted: g.conflicted === true,
    },
    lines: Array.isArray(snapshot.lines) ? snapshot.lines.filter((l) => typeof l === "string") : [],
  };
  const transcript = snapshot.transcript
    .filter((t) => typeof t === "object" && t !== null && typeof t.cmd === "string" && Array.isArray(t.out))
    .map((t) => ({ cmd: t.cmd, out: t.out.filter((l) => typeof l === "string") }));
  return { state, transcript };
}

/** 과제용 초기 상태 생성 */
export function initialStateForScenario(scenario: TerminalTaskSpec["scenario"]): VirtualTerminalState {
  switch (scenario) {
    case "folder-nav": return scenarioFolderNav();
    case "git-basic": return scenarioGitBasic();
    case "git-remote": return scenarioGitRemote();
    case "failure": return scenarioFailure();
  }
}
