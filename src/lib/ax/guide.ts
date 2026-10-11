import type { AxDiagnosis, AxPlan } from "./types";
import { automationLevel, axes, executionProfile, GATE_LABELS, type StepScope } from "./policy";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: "npm install -g @openai/codex@latest", runCommand: "codex", doctorCommand: "codex doctor", loginNote: "첫 실행 시 ChatGPT 계정으로 로그인" },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "npm install -g @anthropic-ai/claude-code", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 브라우저에서 로그인" },
};

/** Inline text marks commands with backticks; `code` blocks default to PowerShell unless labeled as examples. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[]; notes?: string[]; label?: "PowerShell" | ".gitignore" | "예시" } | { kind: "steps"; items: string[] };
export interface AxGuideSection { title: string; when?: string; collapsed?: boolean; listStyle?: "bullets"; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; purpose: string; sections: AxGuideSection[] }

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (lines: string[], notes: string[], label?: Extract<AxGuideBlock, { kind: "code" }>["label"]): AxGuideBlock => ({ kind: "code", lines, notes, ...(label ? { label } : {}) });

export function setupGuide(tool: AxToolId): AxGuideStep[] {
  const guide = TOOL_GUIDES[tool];
  return [
    { title: "시작하기 전에 · 전체 흐름", purpose: `준비부터 Production 확인까지 ${guide.name} 작업 흐름`, sections: [
      { title: "처음 시작할 때", blocks: [
        text(`STEP 01에서 Git·GitHub 인증과 ${guide.name} 설치 여부를 확인하고 필요한 것만 처음 한 번 준비합니다. 이미 설치된 항목은 건너뜁니다.`),
        text("Codex와 Claude Code 중 하나만 사용하면 됩니다"),
      ] },
      { title: "이후 작업할 때", blocks: [
        text("이후 작업은 STEP 02부터 시작합니다. 설치 단계는 반복하지 않습니다."),
      ] },
      { title: "용어 알아보기", collapsed: true, blocks: [{ kind: "steps", items: [
        "CLI: 명령어를 입력해 프로그램을 실행하고 조작하는 방식",
        "저장소(Repository): 프로젝트 파일과 변경 기록을 모아 둔 곳",
        "클론(Clone): GitHub 등의 원격 저장소를 내 PC로 복제하는 작업",
        "브랜치(Branch): 변경을 나누어 진행하는 작업 갈래",
        "풀(Pull): 원격 저장소의 변경 사항을 가져와 현재 브랜치에 통합하는 작업",
        "빌드(Build): 작성한 코드를 실행하거나 배포할 수 있는 형태로 준비하는 과정",
        ".gitignore: Git에 새로 포함하지 않을 파일·폴더 규칙을 적는 파일",
        "환경변수(Environment Variable): 서비스 주소·인증 값 등을 코드 밖에 설정하는 변수",
        "Secret: API Key·비밀번호처럼 공개하면 안 되는 인증 정보",
        "커밋(Commit): 변경을 설명과 함께 Git에 기록하는 단위",
        "푸시(Push): PC의 커밋을 GitHub 같은 원격 저장소에 올리는 작업",
        "풀 리퀘스트(PR): 변경한 코드를 검토하고 대상 브랜치에 반영하도록 요청하는 과정",
        "CI: 코드를 올리면 테스트·빌드 등을 자동 확인하는 과정",
        "Preview: 실제 서비스 반영 전 확인하는 배포 환경",
        "머지(Merge): 서로 다른 브랜치의 변경 사항을 합치는 작업",
        "Production: 사용자가 실제 이용하는 서비스 환경",
        "롤백(Rollback): 문제가 발생했을 때 이전 정상 상태로 되돌리는 작업",
      ] }] },
    ] },
    { title: "STEP 1 · 개발 도구·인증 확인", purpose: `설치 상태와 Git 사용자 정보·GitHub 인증 확인`, sections: [
      { title: "필요한 프로그램 확인", blocks: [
        text("PowerShell에서 버전을 확인합니다. 표시되는 프로그램은 이미 설치됐으므로 설치를 건너뜁니다."),
        text("Node.js는 프로젝트에 필요한 경우에만 준비합니다"),
        code(["git --version", "node --version", "npm --version", guide.versionCommand], []),
      ] },
      { title: "Git 설치", when: "Git 버전이 표시되지 않는 경우에만", blocks: [
        code(["winget install --id Git.Git -e --source winget"], []),
        text("설치 후 새 PowerShell을 열고 `git --version`으로 다시 확인합니다."),
      ] },
      { title: "Node.js 설치", when: "프로젝트에 Node.js가 필요하고 버전이 표시되지 않는 경우에만", blocks: [
        text("nodejs.org에서 LTS를 설치하고 `node --version`으로 다시 확인합니다. 프로젝트에 .nvmrc, .node-version 또는 package.json engines가 있으면 해당 요구사항을 우선합니다."),
      ] },
      { title: "Git 사용자 정보", when: "처음 한 번, 값이 비어 있을 때만", blocks: [
        text("커밋에 기록할 사용자 이름·이메일 확인"),
        code(["git config --global user.name", "git config --global user.email"], []),
        text("비어 있을 때만 설정합니다. 기존 값은 덮어쓰지 않습니다."),
        code(['git config --global user.name "이름"', 'git config --global user.email "메일주소"'], [
          "이름을 본인 이름으로 바꾸어 설정",
          "메일주소를 본인 이메일로 바꾸어 설정",
        ]),
      ] },
      { title: `${guide.name} 설치`, when: `\`${guide.versionCommand}\`이 실패하는 경우에만`, blocks: [
        code([guide.installCommand], []),
        text(`설치 후 \`${guide.versionCommand}\`으로 다시 확인합니다. 문제가 있으면 \`${guide.doctorCommand}\`으로 점검합니다.`),
      ] },
      { title: "GitHub 인증 확인", when: "GitHub CLI(gh)가 설치된 경우에만", blocks: [
        code(["gh auth status"], []),
        text("로그인되어 있지 않으면 `gh auth login`의 안내를 따릅니다. gh가 없으면 GitHub 웹사이트 로그인·토큰 등 프로젝트의 기존 인증 방식을 그대로 사용합니다. 인증 방식을 추측해 바꾸지 않습니다."),
      ] },
    ] },
    { title: "STEP 2 · 프로젝트 준비", purpose: "프로젝트 폴더·의존성·Git 상태 확인", sections: [
      { title: "기본 명령", blocks: [text("`mkdir` 새 폴더 · `cd` 폴더 이동 · `dir` 폴더 내용 · `Get-Location` 현재 위치")] },
      { title: "A. GitHub에 있는 기존 프로젝트", when: "GitHub에는 프로젝트가 있지만 이 PC에는 아직 없는 경우", blocks: [
        code(["mkdir C:\\Work", "cd C:\\Work", "git clone <저장소 URL>", "cd <프로젝트 폴더>", "git status"], [
          "작업용 폴더 만들기 (이미 있으면 건너뜀)",
          "<저장소 URL>을 실제 URL로 바꾸어 프로젝트 내려받기",
          "<프로젝트 폴더>를 내려받은 폴더 이름으로 바꾸어 이동",
        ]),
      ] },
      { title: "B. PC에 이미 있는 프로젝트", when: "이 PC에 기존 프로젝트 폴더가 있는 경우", blocks: [
        code(['cd "C:\\프로젝트\\경로"', "git status", "git branch --show-current", "git remote -v"], [
          "실제 프로젝트 경로로 바꾸어 이동",
          "연결된 원격 URL이 작업할 GitHub 저장소인지 확인",
        ]),
        text("이미 Git 저장소면 그대로 사용합니다. 미커밋 변경이 있으면 `git pull`을 실행하지 말고 AI 도구에 현재 상태를 먼저 확인시킵니다."),
      ] },
      { title: "C. 새 프로젝트", when: "새 폴더에서 처음 시작하는 경우", blocks: [
        code(["mkdir C:\\Work\\MyProject", "cd C:\\Work\\MyProject"], [
          "새 프로젝트 폴더 만들기 (경로·이름은 원하는 값으로 변경)",
        ]),
        text("이후 AI 도구가 요구사항을 확인해 프레임워크, Git 초기화와 GitHub 연결 필요성을 결정합니다. 특정 프레임워크를 임의로 정하지 않습니다."),
        text("작업 후 Git 저장 전에 현재 폴더가 Git 저장소인지, 원격이 연결됐는지, 맞는 GitHub 저장소인지 확인합니다."),
        code(["git status", "git remote -v"], []),
        text("Git 저장소가 아닌 경우에만 초기화할 수 있습니다. 기존 저장소를 재초기화하거나 기존 remote를 덮어쓰지 않고, branch 이름을 main으로 강제하지 않습니다."),
        text("remote가 없으면 GitHub CLI 또는 웹 등 현재 방식대로 GitHub 저장소를 만들고 연결합니다. 첫 push 전에 `git remote -v`로 대상을 다시 확인합니다."),
      ] },
      { title: "의존성 준비", blocks: [
        { kind: "steps", items: [
          "저장소 지침(AGENTS.md·README·packageManager 필드)을 먼저 확인합니다.",
          "package.json이 있으면 scripts와 의존성을 확인합니다.",
          "lockfile 단서 확인: package-lock.json → npm, pnpm-lock.yaml → pnpm, yarn.lock → Yarn, bun.lock/bun.lockb → Bun일 가능성",
          "저장소 지침과 실제 설정에 맞는 기존 방식으로 의존성을 설치합니다.",
        ] },
        text("lockfile 단서 하나로 package manager를 바꾸지 않습니다. 기존 lockfile과 package manager를 우선하며, 설치 과정에서 다른 매니저의 lockfile을 새로 만들거나 기존 lockfile을 교체하지 않습니다. migration은 별도 작업입니다."),
      ] },
      { title: "현재 위치 확인", blocks: [
        code(["Get-Location", "git status"], []),
        text("명령은 실제 프로젝트 폴더에서 실행합니다. 새 프로젝트에 Git 저장소가 아직 없으면 AI 도구와 초기화 필요성을 확인합니다."),
      ] },
    ] },
    { title: `STEP 3 · ${guide.name} 실행`, purpose: `프로젝트 폴더에서 ${guide.name} 실행 후 기존 지침·구현 확인`, sections: [
      { title: "프로젝트 폴더에서 실행", blocks: [
        text("AI 도구는 반드시 작업할 프로젝트 폴더 안에서 실행합니다. `Get-Location`과 `dir`로 위치와 내용을 확인한 뒤 실행하세요."),
        code(['cd "프로젝트 경로"', "Get-Location", "dir", guide.runCommand], [
          "실제 프로젝트 경로로 바꾸어 이동",
        ]),
        text(guide.loginNote),
      ] },
      { title: "작업 시작 전 AI가 먼저 확인할 것", blocks: [{ kind: "steps", items: [
        "저장소 구조 확인",
        "AGENTS.md 같은 프로젝트 지침 파일이 있으면 우선 확인합니다. 없으면 새로 만들라고 강제하지 않습니다.",
        "기존 구현·테스트를 확인한 뒤 작업을 시작합니다.",
      ] }] },
    ] },
    { title: "STEP 4 · 올인원 지시문으로 작업", purpose: "올인원 지시문 전달 및 승인·검토 요청 확인", sections: [
      { title: "올인원 지시문 실행", blocks: [
        text("아래 올인원 지시문 영역에서 복사"),
        { kind: "steps", items: [
          `WorkLens에서 ${guide.name}용 올인원 지시문 전체 복사`,
          "실행한 AI 도구에 지시문 붙여넣기",
          "AI가 저장소를 분석하고 구현·검증을 진행합니다. 승인·검토 요청이 있으면 내용을 확인합니다.",
        ] },
      ] },
    ] },
    { title: "STEP 5 · AI 작업 결과 검증", purpose: "변경 내용·테스트·빌드·핵심 기능 확인", sections: [
      { title: "변경 파일 확인", blocks: [
        code(["git status"], []),
        { kind: "steps", items: [
          "예상한 파일만 변경됐는지 확인합니다.",
          "관계없는 파일·.env·불필요한 build/cache/log가 없는지 확인합니다.",
        ] },
      ] },
      { title: "변경 내용 확인", blocks: [
        code(["git diff"], ["스테이지에 올리지 않은 변경 내용 확인"]),
        text("입문자는 전부 해석할 필요는 없습니다. 예상 밖 대량 삭제·관계없는 수정·Secret·임시 코드가 있는지 확인합니다."),
      ] },
      { title: "테스트·빌드 확인", blocks: [
        text("package.json·프로젝트 지침에서 실제 존재하는 명령만 확인해 실행합니다. AI가 실행했다고 해도 결과를 직접 확인합니다."),
      ] },
      { title: "실제 기능 확인", blocks: [text("가능하면 프로젝트를 직접 실행해 핵심 동작을 확인")] },
      { title: "오류가 나면", blocks: [{ kind: "steps", items: [
        "Git 단계로 넘어가지 말고 오류 메시지·로그의 API Key·Token·Password·개인정보를 [REDACTED]로 가린 뒤 필요한 부분만 AI 도구에 전달합니다. 로그 전체를 무조건 복사하지 않습니다.",
        "AI가 오류를 수정합니다.",
        "같은 검증을 다시 실행합니다.",
        "성공한 뒤 다음 단계로 넘어갑니다.",
      ] }] },
    ] },
    { title: "STEP 6 · .gitignore / Secret 확인 후 Git 저장", purpose: "파일·Secret 확인 후 프로젝트 방식대로 커밋·푸시", sections: [
      { title: "기존 .gitignore 확인", blocks: [
        text(".gitignore가 있으면 덮어쓰지 않습니다. 기존 규칙을 유지하고 필요한 항목만 추가합니다. 새 프로젝트에 없으면 실제 스택을 확인한 뒤 기본 규칙을 만듭니다. 아래는 .gitignore에 적는 예시이며 PowerShell에서 실행하는 명령이 아닙니다."),
        code(["node_modules/", ".env", ".env.local", ".env.*.local", "dist/", "build/", ".next/", "*.log"], [
          "Node.js 의존성 폴더 제외",
          "실제 인증 정보가 들어갈 수 있는 환경변수 파일 제외",
          "로컬 환경변수 파일 제외",
          "환경별 로컬 환경변수 파일 제외",
          "dist 빌드 결과 제외 (프로젝트가 사용하는 경우)",
          "build 빌드 결과 제외 (프로젝트가 사용하는 경우)",
          "Next.js 프로젝트에서만 .next/ 추가",
          "로그 파일 제외",
        ], ".gitignore"),
      ] },
      { title: ".env와 .env.example", blocks: [
        text(".env에는 실제 Secret이 들어갈 수 있어 일반적으로 제외합니다. .env.example은 변수 이름을 공유하는 예제일 수 있으므로 무조건 제외하지 않습니다. 기존 프로젝트 정책을 우선합니다."),
      ] },
      { title: "이미 추적 중인 파일", blocks: [
        text(".gitignore에 넣어도 계속 보이면 이미 Git이 추적 중일 수 있습니다. 파일을 삭제하지 마세요. AI 도구에 Git 상태를 확인시켜 추적만 제거할지 판단합니다."),
      ] },
      { title: "올리기 전 체크리스트", blocks: [
        { kind: "steps", items: [
          "□ 변경 파일이 예상 범위인가", "□ .env·API Key·Secret이 없는가", "□ 불필요한 build·cache·log가 제외됐는가",
          "□ 테스트·빌드가 정상인가", "□ git status에 이상한 파일이 없는가",
        ] },
        text("Secret에는 API Key·Token·Password·서비스 계정 키·개인 인증 파일이 포함됩니다."),
        text("실제 Secret 값을 Git뿐 아니라 AI 대화·터미널 로그·스크린샷에도 붙여넣지 않습니다. 로그를 AI 도구에 전달하기 전에 API Key·Token·Password·개인정보를 [REDACTED]로 가리고 필요한 부분만 전달합니다. 로그 전체를 무조건 복사하지 않습니다."),
        text("이미 노출된 Secret은 .gitignore만으로 보호되지 않습니다. 키를 폐기 → 재발급 → 플랫폼 설정 교체 순서로 대응하고, 필요하면 기록 정리도 검토합니다. 기록 재작성은 자동 실행하지 않습니다."),
      ] },
      { title: "Git 저장 · 스테이지 및 변경 확인", blocks: [
        code(["git add ."], ["현재 폴더 아래 변경 전체를 스테이지에 올립니다. 필요한 파일만 올려도 됩니다."]),
        code(["git status"], ["커밋 대상 확인. 이상하면 커밋을 중단합니다."]),
        code(["git diff --cached --stat"], ["커밋 대상 파일 요약 확인. 파일 수가 과다하거나 대량 삭제·관계없는 파일이 있으면 중단합니다."]),
        text("필요하면 `git diff --cached`로 스테이지에 올린 변경 내용까지 확인합니다."),
      ] },
      { title: "Git 저장 · 브랜치 및 원격 확인", blocks: [
        code(["git branch --show-current"], ["현재 브랜치 확인. main 직접 push인지 PR 방식인지 프로젝트 방식을 확인합니다."]),
        code(["git remote -v"], ["push 대상 원격 URL 확인. 잘못된 저장소에 올리지 않도록 다시 확인합니다."]),
      ] },
      { title: "Git 저장 · 커밋 및 푸시", blocks: [
        code(['git commit -m "작업 내용 요약"'], ["요약을 실제 작업 내용으로 바꾸어 커밋"]),
        code(["git push"], ["프로젝트 방식대로 원격 저장소에 올립니다. push 후에도 배포가 완료된 것은 아닐 수 있습니다."]),
      ] },
    ] },
    { title: "STEP 7 · GitHub CI / PR 확인", purpose: "커밋·CI·PR과 실제 배포 흐름 확인", sections: [
      { title: "GitHub에서 확인할 것", blocks: [{ kind: "steps", items: [
        "방금 올린 커밋이 올바른 브랜치에 있는지 확인합니다.",
        "GitHub Actions/CI의 테스트·빌드 상태를 확인합니다.",
        "PR이 필요한 저장소라면 PR·리뷰·merge 상태를 확인합니다.",
      ] }] },
      { title: "git push가 곧 Production은 아닙니다", blocks: [
        text("프로젝트마다 배포 흐름이 다릅니다. feature 브랜치 → Preview/CI → PR → main merge → Production일 수도 있고, main push → 자동 Production일 수도 있습니다. 실제 배포 브랜치·workflow를 먼저 확인합니다."),
      ] },
      { title: "CI가 실패하면", blocks: [
        { kind: "steps", items: ["실패 로그 확인", "민감정보를 가리고 필요한 로그만 AI 도구에 전달", "오류 수정", "다시 검증", "다시 push하고 CI 결과 확인"] },
        text("CI 실패를 둔 채 Production 배포만 계속 진행하지 않습니다."),
      ] },
    ] },
    { title: "STEP 8 · 배포 (Vercel / Cloudflare)", purpose: "기존 배포 플랫폼·환경·설정에 맞춰 배포 결과 확인", sections: [
      { title: "먼저 현재 배포 환경 확인", blocks: [
        text("Vercel과 Cloudflare를 모두 사용해야 하는 것은 아닙니다. 현재 프로젝트의 실제 배포 구성을 확인하고 사용하는 경로만 따르세요. 프론트엔드와 Worker/API를 나누어 두 플랫폼을 함께 쓰는 프로젝트도 있습니다."),
        text("어떤 서비스가 어느 플랫폼에 어느 branch에서 어떤 방식으로 배포되는지 먼저 확인합니다. Vercel·Cloudflare Workers/Pages·GitHub Actions·Wrangler 등 현재 저장소 설정을 기준으로 하며, 배포 구성을 임의로 변경하거나 추가하지 않습니다."),
        text("Preview는 반영 전 확인용이고 Production은 실제 서비스입니다. feature branch·PR → Preview, main/production branch → Production일 수 있지만 예시이며 실제 설정이 우선합니다. 지금 배포할 환경을 먼저 확인합니다. Preview 확인만으로 Production 배포가 완료된 것은 아닙니다."),
      ] },
      { title: "Vercel인 경우", when: "현재 프로젝트가 Vercel에 배포되는 경우에만", blocks: [
        { kind: "steps", items: ["프로젝트 방식대로 push 또는 main merge", "Vercel build 결과 확인", "Preview 또는 Production 배포 확인", "배포 상태 확인"] },
        text("Git 연동 자동 배포라면 별도 수동 명령이 필요하지 않을 수 있습니다. 자동 배포에 수동 명령을 중복 실행하지 않습니다."),
        text("로컬 .env를 GitHub에 올리지 않고 Vercel Environment Variables에 설정합니다. 변수 이름은 프로젝트에서 확인합니다. Preview·Production 값을 따로 설정할 수 있습니다."),
        { kind: "steps", items: ["실패 시 배포 로그 확인", "민감정보를 가리고 필요한 로그만 AI 도구에 전달", "오류 수정", "테스트", "commit/push", "재배포 결과 확인"] },
      ] },
      { title: "Cloudflare인 경우", when: "현재 프로젝트가 Cloudflare에 배포되는 경우에만", blocks: [
        text("Workers인지 Pages인지 먼저 확인합니다. Git 자동 배포인지 Wrangler 등 기존 CLI 방식인지 현재 프로젝트 설정을 확인합니다."),
        { kind: "steps", items: ["Git 자동 배포라면 프로젝트 방식대로 push/merge", "배포 진행 확인", "배포 상태 확인"] },
        text("자동 배포에 수동 명령을 중복 실행하지 않습니다. CLI 방식이면 프로젝트에 실제 있는 배포 명령만 실행합니다. `wrangler deploy`를 모든 프로젝트에 강제하지 않습니다."),
        text("Secret은 코드에 넣지 않고 Cloudflare Variables/Secrets에 설정합니다."),
      ] },
    ] },
    { title: "STEP 9 · Production 최종 확인", purpose: "실제 서비스의 화면·기능 확인과 문제 대응", sections: [
      { title: "실제 서비스 확인", blocks: [
        text("URL만 생겼다고 완료된 것은 아닙니다"),
        { kind: "steps", items: [
          "Production URL 접속", "첫 화면 로딩 확인", "핵심 기능 1~2개 실행",
          "주요 요청 확인", "Desktop 확인", "Mobile 확인", "브라우저 Console 오류 확인",
        ] },
        text("로그인·환경변수·API처럼 Production에서만 달라질 수 있는 기능이 있다면 실제 Production 환경에서도 확인합니다."),
      ] },
      { title: "문제가 생기면", blocks: [{ kind: "steps", items: [
        "로그·브라우저 오류 확인", "API Key·Token·Password·개인정보를 [REDACTED]로 가린 뒤 필요한 오류 내용만 AI 도구에 전달합니다. 로그 전체를 무조건 복사하지 않습니다.", "문제 수정", "다시 검증", "commit/push", "재배포 결과 확인",
      ] }] },
      { title: "되돌리기(Rollback)", blocks: [
        text("무작정 계속 고치기보다 Vercel·Cloudflare에서 이전 정상 배포로 되돌릴 수 있는지 먼저 확인합니다. 실제 방식은 플랫폼 설정을 확인한 뒤 정합니다. 되돌리기는 자동 실행하지 않습니다."),
      ] },
    ] },
  ];
}

function axPromptTitle(taskName?: string): string {
  const name = taskName?.trim() || "업무";
  return `# ${name.endsWith("자동화") ? name : `${name} 자동화`} 구현 지시문`;
}

/** Level constraints keep the implementation inside the diagnosed automation scope; a higher level is not a goal. */
const LEVEL_CONSTRAINTS = [
  "업무 정리와 검토·검증 수준으로 진행하세요. 시스템이 업무를 자동 실행하는 기능을 추가하지 마세요.",
  "결과를 만들어 제안하는 보조 기능 중심으로 구현하고 자동 실행은 넣지 마세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 Level 2~3 수준으로 확대하지 마세요.",
  "반복·규칙 기반 단계는 자동화할 수 있지만 주요 예외와 승인 단계는 담당자에게 유지합니다.",
  "높은 수준의 자동화가 가능하지만 승인·안전·법률·권한과 관련된 단계는 진단 결과대로 유지합니다.",
] as const;

/** Gate rules for section 03. A blocked gate never permits implementation, scaffolding or operational connection. */
const GATE_CONSTRAINTS = {
  ready: "현재 진단상 진행할 수 있습니다. 아래 항목이 있으면 해당 단계를 구현하기 전에 확인하세요.",
  conditional: "아래 항목을 저장소·실제 자료·담당자 답변으로 확인한 단계만 구현하세요. 확인되지 않은 항목에 의존하는 단계는 구현하지 말고 '확인·승인 대기'로 보고하세요.",
  blocked: "차단 사유가 해결되기 전에는 기능 구현·코드 생성·스캐폴딩·운영 연결을 하지 마세요. 저장소 분석과 아래 검토·검증, 해결 방안 정리만 수행하세요.",
} as const;

const OWNER_LABELS = { 시스템: "시스템", AI: "AI", 사용자: "담당자" } as const;
/** Quantified targets (절감률·정확도·배수) need evidence the plan cannot carry, so such items are removed. */
const UNSUPPORTED_METRIC = /\d+(?:\.\d+)?\s*(?:%|퍼센트|배)/u;
const ORGANIZATION = /[가-힣A-Za-z]+(?:팀|부서|본부)/gu;
const AUTO_ACTION = /자동(?:으로)?\s*(삭제|제거|승인|등록|전송|결재|수정|보정)/u;
const SYSTEM_INTERFACE = /\bAPI\b|SDK|엔드포인트|endpoint/iu;
const UNCONFIRMED = "(확인 필요:";
type PlanListKey = Exclude<keyof AxPlan, "repositoryFirst">;

/**
 * Second line of defense after the generation prompt: keep grounded items, qualify plausible but unverified
 * ones in place, drop unsupported metrics. Qualified items carry the marker, so applying it twice changes nothing.
 */
export function guardPlan(plan: AxPlan, context: string): AxPlan {
  // Exclusions and prerequisites already name what must not happen or must be checked; only metrics and orgs apply there.
  const guardItem = (item: string, qualify: boolean): string | null => {
    if (UNSUPPORTED_METRIC.test(item)) return null;
    let value = item.replace(ORGANIZATION, org => context.includes(org) ? org : "담당 조직");
    if (value.includes(UNCONFIRMED)) return value;
    const action = qualify ? AUTO_ACTION.exec(value)?.[1] : undefined;
    if (action && !new RegExp(`자동(?:으로)?\\s*${action}`, "u").test(context)) value = `${value} ${UNCONFIRMED} 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)`;
    else if (qualify && SYSTEM_INTERFACE.test(value) && !/확인/u.test(value) && !SYSTEM_INTERFACE.test(context)) value = `${value} ${UNCONFIRMED} 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)`;
    if (value !== item && value.includes("담당 조직") && !value.includes(UNCONFIRMED)) value = `${value} ${UNCONFIRMED} 실제 담당 조직을 확인하세요)`;
    return value;
  };
  const guarded = { ...plan };
  for (const key of Object.keys(plan) as (keyof AxPlan)[]) {
    if (key === "repositoryFirst") continue;
    const qualify = key !== "outOfScope" && key !== "prerequisites";
    guarded[key as PlanListKey] = plan[key as PlanListKey].map(item => guardItem(item, qualify)).filter((item): item is string => item !== null);
  }
  return guarded;
}

/** Only presentation labels and whitespace are ignored; longer or qualified statements remain distinct. */
const normalizedItem = (item: string) => item.trim()
  .replace(/^(?:(?:\d+[.)]|[①-⑳]|[-*•·])\s*)+/u, "")
  .replace(/\s+/gu, "")
  .replace(/\(담당자수행\)$/u, "");
const unique = (items: string[]) => {
  const seen = new Set<string>();
  return items.map(item => item.trim()).filter(item => {
    const key = normalizedItem(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const mergeDistinct = (base: string[], extra: string[]) => unique([...base, ...extra]);
const without = (items: string[], shown: string[]) => {
  const keys = new Set(shown.map(normalizedItem));
  return unique(items).filter(item => !keys.has(normalizedItem(item)));
};

/**
 * Read-only Step 4 summary of the diagnosed execution scope. A generated tool plan contributes only its own
 * prerequisites; its proposals stay in the full instruction. Nothing is persisted.
 */
export interface AxPlanSummary {
  include: string[]; humanKept: string[]; excluded: string[];
  prerequisites: string[];
  data: { label: string; items: string[] }[];
  tests: string[]; acceptance: string[]; exceptions: string[];
}

export function planSummary(diagnosis: AxDiagnosis, rawPlan?: AxPlan, context = ""): AxPlanSummary {
  const profile = executionProfile(diagnosis);
  const humanKept = mergeDistinct(profile.manualSteps.map(step => `${step} (담당자 수행)`), diagnosis.humanInLoop);
  // Diagnosed steps beyond the permitted scope (a blocked gate permits Level 0 work); manual steps are listed as human work.
  const scopeLevel = profile.gate === "blocked" ? 0 : profile.level;
  const restricted = [
    ...(scopeLevel >= 2 ? [] : profile.automationSteps.map(step => `${step} 자동 실행`)),
    ...(scopeLevel >= 1 ? [] : profile.assistSteps.map(step => `${step} AI 보조 구현`)),
  ];
  const manualAutomation = profile.manualSteps.map(step => `${step} 자동화 (담당자 수행)`);
  const prerequisites = unique(profile.gate === "blocked" ? profile.blockReasons : profile.prerequisites);
  const planPrerequisites = rawPlan && profile.gate !== "blocked" ? without(guardPlan(rawPlan, context).prerequisites, prerequisites) : [];
  const tests = unique(profile.poc.evaluation);
  return {
    include: unique(profile.poc.inScope),
    humanKept,
    excluded: mergeDistinct(restricted, without(profile.poc.outOfScope, manualAutomation)),
    prerequisites: [...prerequisites, ...planPrerequisites],
    data: [
      { label: "입력", items: unique(diagnosis.asIs.inputs) },
      { label: "출력", items: unique(diagnosis.asIs.outputs) },
      { label: "사용 시스템", items: unique(diagnosis.asIs.systems) },
      { label: "검증용 입력", items: without(profile.poc.inputs, diagnosis.asIs.inputs) },
      { label: "검증용 출력", items: without(profile.poc.outputs, diagnosis.asIs.outputs) },
    ].filter(row => row.items.length),
    tests,
    acceptance: [
      ...without(profile.poc.success, tests).map(item => `성공: ${item}`),
      ...without(profile.poc.failure, tests).map(item => `실패: ${item}`),
    ],
    exceptions: mergeDistinct(diagnosis.asIs.exceptions, diagnosis.risks),
  };
}

/** Comparative targets ("동일하거나 감소", "개선") cannot pass or fail until an expected result is defined. */
const VAGUE_CRITERION = /감소|증가|개선|단축|향상|최소화|최대화/u;
/** Level 0~1 never run unattended; a generated proposal that does is outside the current scope. */
const UNATTENDED = /자동|무인/u;
const SCOPE_TITLES = { implement: "이번 구현", "after-check": "확인 후 구현", verify: "검토·검증만" } as const;
const stripEnumerator = (item: string) => item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "").trim();
type Placement = { kind: "excluded" } | { kind: "outside"; reason: string; human?: boolean } | { kind: "linked"; step: string } | { kind: "unlinked" };

/**
 * One coding-agent instruction for Codex, Claude Code or any other agent. Every section reads the same scope:
 * the execution profile's per-step treatment (Level × Gate). Generated plan items only add detail inside that
 * scope; items the structure cannot place are marked for confirmation, never promoted to implementation.
 */
export function buildAllInOnePrompt(rawPlan: AxPlan | undefined, _tool: AxToolId, options: { taskName?: string; prerequisites?: string[]; diagnosis?: AxDiagnosis; context?: string } = {}): string {
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${stripEnumerator(item)}`).join("\n");
  const plan = rawPlan ? guardPlan(rawPlan, [options.taskName ?? "", options.context ?? ""].join("\n")) : undefined;
  const d = options.diagnosis;
  const profile = d ? executionProfile(d) : undefined;
  const level = d ? automationLevel(d) : undefined;
  const gate = profile?.gate;
  const scopeLevel = profile ? gate === "blocked" ? 0 : profile.level : undefined;
  const steps = profile?.stepScope ?? [];
  const work = steps.filter(s => s.scope === "implement" || s.scope === "after-check");
  const review = steps.filter(s => s.scope === "verify");
  const future = steps.filter(s => s.scope === "future");
  const human = steps.filter(s => s.scope === "human");
  // Generated restatements of a diagnosed human step ("담당자 X", "X 자동화") add nothing; distinct wording stays.
  const humanForms = new Set(human.flatMap(s => [s.step, `${s.step} (담당자 수행)`, `담당자 ${s.step}`, `${s.step} 자동화`, `${s.step} 자동화 (담당자 수행)`]).map(normalizedItem));
  const restated = (items: string[] = []) => items.filter(item => !humanForms.has(normalizedItem(item)));
  const humanKept = unique([...human.map(s => `${s.step} (담당자 수행)`), ...(d?.humanInLoop ?? []), ...restated(plan?.humanInLoop)]);
  const excluded = without([...(profile ? without(profile.poc.outOfScope, human.map(s => `${s.step} 자동화 (담당자 수행)`)) : []), ...restated(plan?.outOfScope)], humanKept);

  // Placement is structural: exact exclusions, then containment of a diagnosed step name, then the Level rule.
  const closed = new Set([...[...excluded, ...humanKept].map(normalizedItem), ...humanForms]);
  const mentions = (item: string, step: string) => item.includes(step) || step.includes(item);
  // guardPlan's "(확인 필요: …)" qualifier must not hide that an item restates an exclusion or a step.
  const core = (item: string) => item.replace(/\s*\(확인 필요:[^)]*\)\s*$/u, "");
  const place = (item: string): Placement => {
    const text = core(item);
    if (closed.has(normalizedItem(text))) return { kind: "excluded" };
    const outsideStep = [...human, ...future].find(s => mentions(text, s.step));
    if (outsideStep) return { kind: "outside", reason: outsideStep.scope === "human" ? "담당자 수행 단계" : `현재 Level ${scopeLevel} 범위 밖`, human: outsideStep.scope === "human" };
    if (scopeLevel === undefined) return { kind: "unlinked" };
    if (scopeLevel === 0) return { kind: "outside", reason: gate === "blocked" ? "진행 보류 상태" : "Level 0은 검토·검증만 허용" };
    if (scopeLevel < 2 && UNATTENDED.test(text)) return { kind: "outside", reason: `Level ${scopeLevel}은 자동 실행 대신 후보·초안까지만 허용` };
    const linked = work.find(s => mentions(text, s.step));
    return linked ? { kind: "linked", step: linked.step } : { kind: "unlinked" };
  };
  const placed = (items: string[] = []) => unique(items.map(stripEnumerator)).map(item => ({ item, at: place(item) }));
  const goals = placed(plan?.goal), proposals = placed([...(plan?.inScope ?? []), ...(plan?.implementation ?? [])]);
  const acceptance = placed(plan?.acceptance), planTests = placed(plan?.tests);
  const outsideItems = [...goals, ...proposals, ...acceptance, ...planTests].flatMap(({ item, at }) => at.kind === "outside" ? [{ text: `생성 계획 제안: ${core(item)} — ${at.reason}`, human: !!at.human }] : []);
  const outside = unique(outsideItems.filter(o => !o.human).map(o => o.text)), outsideHuman = unique(outsideItems.filter(o => o.human).map(o => o.text));
  const inside = (list: { item: string; at: Placement }[]) => list.filter(({ at }) => at.kind === "linked" || at.kind === "unlinked");
  const unlinked = proposals.filter(({ at }) => at.kind === "unlinked").map(({ item }) => item);

  const gaps = !d ? ["진단 결과 없음: Level·실행 상태를 확인하기 전에는 생성 계획의 제안을 확정 구현하지 마세요."] : [
    ...(d.asIs.inputs.length ? [] : ["입력 자료와 샘플 형식 (진단에 입력 정보 없음)"]),
    ...(d.asIs.outputs.length ? [] : ["결과물 형식과 보고 양식 (진단에 출력 정보 없음)"]),
    ...(steps.length ? [] : ["업무 단계별 진단 정보 없음: 구현할 단계와 담당자 단계를 먼저 확인"]),
  ];
  // An open technical check is listed once; "<topic> 확인" restatements from the plan or caller are the same item.
  const openTopics = new Set((d?.technicalChecks ?? []).filter(c => c.status !== "확인됨").flatMap(c => [c.topic, `${c.topic} 확인`]).map(normalizedItem));
  const extra = (items: string[] = []) => items.filter(item => !openTopics.has(normalizedItem(item)));
  const conditions = unique([...(gate === "blocked" ? [] : profile?.prerequisites ?? []), ...extra(plan?.prerequisites), ...extra(options.prerequisites), ...extra(plan?.integrations), ...gaps]);
  const exceptions = unique([...(plan?.exceptions ?? []), ...(d?.asIs.exceptions ?? []), ...(d?.risks ?? [])]);
  const isAssist = (s: StepScope) => !!s.treatment?.startsWith("AI 보조");
  const doneWhen = (s: StepScope) => isAssist(s)
    ? "실제 입력으로 후보·초안이 생성되고, 담당자 확정 전에는 운영 결과로 반영되지 않으며, 생성할 수 없는 건은 검토 필요·실패로 표시됩니다."
    : "확인된 규칙으로 실제 입력이 처리되고, 규칙에 맞지 않거나 확인할 수 없는 건은 정상 결과와 분리됩니다.";
  const stepLine = (s: StepScope) => `${s.step} — ${s.treatment}${s.note ? ` (진단 메모: ${s.note})` : ""}`;

  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.filter(Boolean).join("\n\n") });
  const objective = !profile ? "진단 결과가 없어 실행 범위를 확정할 수 없습니다. 진단 결과를 확인하기 전에는 아래 제안을 구현하지 말고 확인할 항목을 보고하세요."
    : scopeLevel === 0 ? `${gate === "blocked" ? "진행 보류 상태입니다." : "Level 0 범위입니다."} 운영 기능을 구현하지 말고 아래 검토·검증 결과와 다음 진단에 필요한 정보를 보고하세요.`
    : !work.length ? "현재 실행 범위에 구현할 업무 단계가 없습니다. 아래 확인 작업과 보고만 수행하세요."
    : gate === "ready" ? "'이번 구현' 단계를 실제 입력으로 동작하고 검증된 기능으로 완성하세요."
    : "선행 확인으로 조건이 확인된 '확인 후 구현' 단계만 실제로 동작하고 검증된 기능으로 완성하세요. 확인되지 않은 단계는 보류 사유와 함께 보고하세요.";
  const scopeGroups = (["implement", "after-check", "verify"] as const).map(kind => {
    const items = steps.filter(s => s.scope === kind);
    return items.length ? `### ${SCOPE_TITLES[kind]}\n\n${numbered(items.map(stepLine))}` : "";
  });
  const a = d ? axes(d) : undefined;
  section("작업 목표·실행 범위",
    d && level && gate && a ? `### 진단 기준\n\n${bullets([
      ...(d.asIs.purpose ? [`업무 목적: ${d.asIs.purpose}`] : []),
      `자동화 수준: ${level.label.replace(/^L\d+ /u, "")} · Level ${level.level}${level.provisional ? " (정보 부족으로 잠정 판정)" : ""}`,
      `자동화 가치: ${a.value}/5`, `기술 실현 가능성: ${a.feasibility}/5`, `담당자 판단 필요도: ${a.judgment}/5`, `운영 위험: ${a.risk}/5`,
      `실행 상태: ${GATE_LABELS[gate]}`,
    ])}\n\n${LEVEL_CONSTRAINTS[level.level]} 실제 실행 범위는 Level 정책과 실행 상태가 함께 허용한 범위이며, TO-BE·생성 계획·매트릭스 위치는 이 범위를 넓히지 않습니다.` : "",
    `### 이번 작업 목표\n\n${objective}`,
    inside(goals).length ? `생성 계획의 목표 (참고, 위 범위 안에서만 적용)\n\n${bullets(inside(goals).map(({ item }) => item))}` : "",
    ...scopeGroups,
    profile?.scopeSupport.length ? `### 함께 수행할 확인\n\n${bullets(profile.scopeSupport)}` : "",
    future.length || outside.length ? `### 향후 확장 (이번 작업에서 구현하지 않음)\n\n${bullets([
      ...future.map(s => `${s.step} — ${s.verdict} 단계지만 현재 Level ${scopeLevel} 범위 밖${s.note ? ` (진단 메모: ${s.note})` : ""}`),
      ...outside,
    ])}` : "",
    humanKept.length || excluded.length || outsideHuman.length ? `### 제외·담당자 유지 (자동화로 대체하지 않음)\n\n${bullets([...humanKept, ...excluded, ...outsideHuman])}` : "",
  );
  section("프로젝트 사전 확인",
    "WorkLens는 진단 시점에 대상 저장소를 보지 않았습니다. 파일 경로·함수명·기술 스택·DB·API·인증·계산식·테스트 명령·배포 환경은 저장소와 실제 자료에서 확인한 내용만 사용하세요.",
    numbered([
      "저장소 지침 파일(AGENTS.md 등)이 있으면 먼저 읽고 그 규칙을 따르세요.",
      "`git status`와 현재 branch로 작업 상태와 기존 미커밋 변경을 확인하세요.",
      "프로젝트 구조, framework/runtime, package manager와 lockfile, package scripts의 테스트·typecheck·빌드·배포 명령을 확인하세요.",
      "이 프로젝트가 웹 애플리케이션인지, 로컬 스크립트·CLI·Excel 자동화인지 확인하세요. 웹이면 기존 컴포넌트·라우팅·API·인증·저장 방식을, CLI·스크립트면 기존 명령과 처리 구조를, Excel 기반이면 실제 샘플과 기존 매크로·템플릿을 재사용하고, 필요 없는 웹 프로젝트나 UI를 새로 만들지 마세요.",
      "새 프로젝트라면 실행 환경과 요구사항을 확인하고, 프레임워크·DB·배포 서비스를 임의로 고르지 말고 결정에 필요한 정보를 '확인 필요'로 보고하세요.",
      "'작업 목표·실행 범위'의 단계와 관련된 기존 구현·데이터 흐름·실제 샘플·업무 규칙을 확인하세요.",
      "사용 중인 코딩 에이전트(Codex·Claude Code·OMP 등)에서 실제로 쓸 수 있는 도구와 권한을 확인하고, 없는 도구나 명령을 전제로 작업하지 마세요.",
    ]),
    "확인한 사실과 추정을 구분해 기록하고, 추정은 '확인 필요'로 남기세요.",
  );
  section("선행 조건·차단 사항",
    gate ? `실행 상태는 \`${GATE_LABELS[gate]}\`입니다. ${GATE_CONSTRAINTS[gate]}` : "",
    gate === "blocked" && profile?.blockReasons.length ? `### 차단 사유\n\n${bullets(profile.blockReasons)}` : "",
    conditions.length ? `### 확인할 항목\n\n${bullets(conditions)}` : "",
    "확인되지 않은 API·권한·파일 형식·연동 방식·계산식·반올림·중복 기준·승인 주체를 가정해 구현하지 마세요.",
  );
  const inputs = d ? unique([...d.asIs.inputs, ...without(d.poc.inputs, d.asIs.inputs).map(item => `검증용: ${item}`)]) : [];
  const outputs = d ? unique([...d.asIs.outputs, ...without(d.poc.outputs, d.asIs.outputs).map(item => `검증용: ${item}`)]) : [];
  if (d || plan?.dataFlow.length) section("업무 데이터 흐름",
    inputs.length || d?.asIs.trigger || d?.asIs.systems.length ? `### 입력\n\n${bullets([
      ...inputs, ...(d?.asIs.trigger ? [`시작 시점: ${d.asIs.trigger}`] : []), ...(d?.asIs.systems.length ? [`사용 시스템: ${d.asIs.systems.join(", ")}`] : []),
    ])}\n\n실제 샘플의 형식과 필수 항목을 확인한 뒤 처리하고, 확인 전에는 항목명·경로를 하드코딩하지 마세요.` : "",
    d?.asIs.steps.length ? `### 현재 업무 흐름 (AS-IS)\n\n${numbered(d.asIs.steps)}` : "",
    d?.toBe.length ? `### 목표 업무 흐름 (TO-BE, 참고)\n\n${numbered(d.toBe.map(s => `${s.step} — ${OWNER_LABELS[s.owner]}: ${s.description}`))}\n\nTO-BE는 장기 방향입니다. 이번 구현 범위는 '작업 목표·실행 범위'를 따르세요.` : "",
    plan?.dataFlow.length ? `### 처리 흐름 (생성 계획)\n\n${bullets(plan.dataFlow)}` : "",
    `### 출력\n\n${outputs.length ? `${bullets(outputs)}\n\n` : ""}결과는 정상·검토 필요·확인 불가·처리 실패로 구분하고, 실패·확인 불가 건을 정상 결과에 섞지 마세요.`,
    "### 계산·판정 기준\n\n업무에 계산·판정이 있으면 확인된 계산식·입력·순서·반올림·누락 처리 기준만 사용하세요. 정의되지 않은 기준은 구현하지 말고 '확인 필요'로 보고하세요.",
    "### 추적\n\n원본 추적이 필요한 업무라면 결과에서 원본 출처·처리 단계·오류 위치·담당자 확인 결과를 확인할 수 있게 유지하세요. 업무와 관계없는 식별 정보(예: 시트·행 번호)를 강제하지 마세요.",
  );
  const linkedTo = (step: string) => proposals.filter(({ at }) => at.kind === "linked" && at.step === step).map(({ item }) => item);
  section("단계별 실제 구현",
    work.length ? `구현은 입력 확인 → 형식 검증 → 처리 → 예외 분리 → 결과 생성 → 담당자 확인 중 이 업무에 해당하는 단계만 의존 순서대로 연결하세요.\n\n${work.map((s, i) => `### 단계 ${i + 1}. ${s.step} — ${s.treatment}\n\n${bullets([
      `처리 상태: ${s.scope === "implement" ? SCOPE_TITLES.implement : `${SCOPE_TITLES["after-check"]} (관련 확인 항목이 확인되기 전에는 보류)`}`,
      ...(s.note ? [`진단 메모: ${s.note}`] : []),
      `담당자 확인: ${isAssist(s) ? "AI 결과는 제안값으로 표시하고 담당자가 확정한 값과 구분하세요." : scopeLevel === 2 ? "규칙으로 처리할 수 없는 예외는 담당자 확인으로 넘기세요." : "실패하면 기존 수동 절차로 전환할 수 있게 하세요."}`,
      ...linkedTo(s.step).map(item => `세부 제안 (생성 계획): ${item}`),
      `완료 기준: ${doneWhen(s)}`,
    ])}`).join("\n\n")}` : "",
    review.length ? `### 검토·검증 작업\n\n${bullets([...review.map(s => `${s.step} ${s.treatment}`), ...(profile?.scopeSupport ?? [])])}\n\n샘플과 업무 규칙으로 확인한 결과를 보고하는 범위입니다. ${gate === "blocked" ? "운영 기능·자동 실행 코드·스캐폴딩을" : "운영 기능이나 자동 실행 코드를"} 만들지 마세요.` : "",
    unlinked.length ? `### 범위 확인이 필요한 생성 계획 제안\n\n${bullets(unlinked)}\n\n위 제안은 '작업 목표·실행 범위'의 어느 단계에 속하는지 확인되기 전에는 구현하지 마세요.` : "",
    work.length ? "### 실제 동작하는 기본 토대\n\n필요한 자료와 확인이 갖춰진 단계는 실제 입력을 받고, 정의된 처리를 실행하고, 잘못된 입력과 실패를 정상 결과와 구분하고, 필요한 담당자 확인을 유지하고, 실행·검증 방법을 제공해야 완료입니다.\n\n처리 없는 화면, 읽지 못하는 업로드, 더미 데이터 결과, 가짜 API 응답, TODO만 있는 핵심 함수, 실행되지 않는 샘플 코드, 검증하지 않은 계산, 미확인 규칙을 가정한 구현, 승인 없이 확정되는 AI 결과는 완료가 아닙니다.\n\n필수 자료가 없으면 전체 흐름을 억지로 완성하지 말고 허용된 독립 단계만 완성하세요. 허용된 독립 단계가 없으면 코드를 만들지 말고 필요한 선행 확인사항을 보고하세요." : "",
    "기존 구현을 우선 재사용하고 요청 범위 안에서 최소한으로 수정하세요. 요청하지 않은 기능·라이브러리, 하드코딩 값, 실제 로직에 남은 테스트용 임시 데이터, 근거 없는 수치 목표, 확인되지 않은 담당 조직·승인 주체를 만들지 마세요.",
  );
  const fallback = unique([...(d?.operation.fallback ? [d.operation.fallback] : []), ...(plan?.fallback ?? []), ...(plan?.operation ?? [])]);
  section("예외·보안·승인",
    exceptions.length ? `### 예외\n\n${bullets(exceptions)}` : "",
    "실패·미매칭·확인 불가 데이터는 정상 결과와 분리해 원인과 대상을 확인할 수 있게 하세요. 자동 삭제·자동 보정은 업무 규칙에 명시된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요.",
    work.length ? "### 반복 실행\n\n같은 입력 재처리, 같은 이름의 다른 파일, 일부 성공 후 실패, 처리 중단·재시도, 이전 요청의 뒤늦은 완료, 입력 변경 후 기존 결과 재사용 중 이 업무에 해당하는 경우를 확인하세요. 기존 처리 정책을 먼저 따르고, 중복 반영·기존 데이터 삭제·미검증 데이터의 정상 집계가 없게 하되 필요 없는 작업 큐·트랜잭션 구조는 추가하지 마세요." : "",
    `### 담당자 확인·승인\n\n${humanKept.length ? "'제외·담당자 유지' 항목은 자동화하지 마세요. " : ""}AI 제안과 담당자 확정값을 구분하고, 승인 전에는 결과를 확정하거나 외부로 전송하지 마세요. 승인 주체·권한이 확인되지 않았으면 지정하지 마세요.`,
    `### 보안\n\n${bullets([
      ...(plan?.security ?? []),
      "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
      "기존 인증·권한 구조와 최소 권한 원칙을 유지하고, 민감한 데이터를 불필요하게 로그에 남기지 마세요.",
      "외부 AI 서비스로 업무 자료를 보내기 전에 보안 조건을 확인하고, 확인되지 않은 연동은 자동 실행하지 마세요.",
    ])}`,
    `### 수동 전환\n\n${fallback.length ? `${bullets(fallback)}\n\n` : ""}자동화가 실패해도 기존 수동 업무를 계속할 수 있게 유지하세요. 실제 수동 절차와 운영 담당이 확인되지 않았으면 새로 정하지 마세요.`,
  );
  const tests = unique([...(profile?.poc.evaluation ?? []), ...inside(planTests).map(({ item }) => item)]);
  section("테스트·회귀 검증",
    "저장소에 실제로 존재하는 검증 명령과 도구를 확인한 뒤 실행하세요. 없는 테스트 framework나 명령을 임의로 설치하지 마세요.",
    `### 정상 케이스\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}기대 결과가 확정된 샘플로 결과를 대조하세요. 기대 결과·허용 오차가 정의되지 않았으면 합격 기준을 만들지 말고 '확인 필요'로 보고하세요.`,
    "### 경계값\n\n입력 1건, 빈 입력, 같은 기준값이 여러 건인 경우, 선택 항목이 비어 있는 경우처럼 이 업무의 입력에 해당하는 경계 상황을 확인하세요.",
    `### 실패·예외 케이스\n\n${exceptions.length ? "'예외·보안·승인'의 각 예외를 재현하고, " : ""}잘못된 형식·필수 항목 누락 같은 실패가 정상 결과로 표시되지 않는지 확인하세요.`,
    "### 범위·승인\n\n담당자 확인 전 결과가 확정·전송되지 않는지, '향후 확장'·'제외' 항목이 실행되지 않는지 확인하세요.",
    "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요. 웹 UI를 포함하면 기존 브라우저/E2E 도구가 있을 때 주요 화면을 Desktop과 Mobile에서 확인하고, 도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
  );
  section("Git·배포·운영", bullets([
    "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고 기존 작업을 덮어쓰지 마세요.",
    "의도한 파일만 `git add <파일>`로 stage하세요. `git add .`로 전체를 추가하지 마세요.",
    "force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
    "stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요. 허용되지 않으면 실행하지 말고 현재 Git 상태, 추천 commit 메시지, 다음에 실행할 명령을 보고하세요.",
    "웹 애플리케이션이면 저장소의 기존 CI/CD·배포 설정과 package scripts에서 배포 방식을 먼저 확인하세요. 배포 플랫폼을 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
    "로컬 스크립트·CLI·Excel 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용 방법을 정리하세요.",
    "배포 방식을 확인할 수 없으면 '배포 방식 확인 필요'로 보고하세요.",
    "구현을 마쳤다는 이유만으로 배포하지 마세요. Production 배포는 사용자가 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요.",
    "배포 또는 운영 적용을 수행했다면 실제 환경에서 입력 → 처리 → 결과 흐름과 오류 여부를 확인하세요. 배포하지 않았다면 운영 검증 완료로 보고하지 마세요.",
  ]));
  const diagnosedCriteria = [...(profile?.poc.success ?? []), ...(profile?.poc.failure ?? [])];
  const criteria = without(inside(acceptance).map(({ item }) => item), diagnosedCriteria).map(item => VAGUE_CRITERION.test(item) ? `${item} (확인 필요: 기대 결과를 정의한 뒤 판정)` : item);
  section("완료 조건",
    work.length ? `### 단계별\n\n${bullets(work.map(s => s.scope === "implement" ? `${s.step}: ${doneWhen(s)}` : `${s.step}: 확인 항목이 확인되어 구현했다면 ${doneWhen(s)} 확인하지 못했다면 '확인·승인 대기'로 보고합니다.`))}` : "",
    review.length ? "### 검토·검증\n\n각 검토·검증 항목의 결과와 근거 자료, 다음 진단에 필요한 정보가 보고됩니다." : "",
    profile?.poc.success.length || profile?.poc.failure.length || criteria.length ? `### 판정 기준\n\n${bullets([
      ...(profile?.poc.success ?? []).map(item => `성공: ${item}`), ...(profile?.poc.failure ?? []).map(item => `실패: ${item}`), ...criteria,
    ])}` : "",
    `### 공통\n\n${bullets([
      "기존 기능과 데이터가 유지됩니다.",
      ...(humanKept.length ? ["담당자 검토·승인 단계가 유지됩니다."] : []),
      "'향후 확장'·'제외' 항목이 구현되거나 실행되지 않습니다.",
      "정상·경계·실패 케이스 검증이 통과하고, 실패 건이 정상 결과와 구분됩니다.",
      "타입 오류와 빌드 오류가 없습니다.",
      "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
    ])}`,
    `### 완료 상태 구분\n\n${bullets([
      "구현·검증 완료: 실제 구현 후 검증 통과", "구현 완료·검증 미완료: 구현했지만 정상 동작 확인 부족", "부분 구현: 허용된 일부 기능만 구현",
      "확인·승인 대기: 필수 정보 또는 승인 부족", "정책상 제외·차단: 현재 실행 대상 아님", "구현 실패: 구현 또는 검증 실패",
    ])}\n\n스캐폴딩·TODO·모의 구현만 있는 기능은 완료로 보고하지 마세요.`,
  );
  section("인수인계·완료 보고", "작업이 끝나면 다음 형식으로 보고하세요.", numbered([
    "확인한 프로젝트 구조", "현재 Level·실행 상태와 허용 범위", "단계별 완료 상태 (위 완료 상태 구분 사용)", "수정·생성한 파일", "입력·처리·출력 구조",
    "실제로 확인한 실행 방법과 명령", "검증 결과 (실행하지 않은 검증은 미실행)", "담당자 확인이 필요한 항목", "미구현·보류·차단된 기능과 해결 조건",
    "다음 개발 단계", "Git 상태", "배포·운영 적용 상태",
  ]), "확인하지 않은 환경변수·API·파일 경로를 적지 말고, 계획이나 미구현 기능을 실행 가능한 코드와 구분하세요. 실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.");
  return [
    axPromptTitle(options.taskName),
    "WorkLens 업무 자동화 진단 결과로 만든 실행 지시문입니다. Codex·Claude Code·OMP 등 어떤 코딩 에이전트에서도 같은 실행 범위와 완료 기준을 따르세요. 대상 저장소를 먼저 확인한 뒤 '작업 목표·실행 범위' 안에서만 구현하세요.",
    ...sections.filter(s => s.body).map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.body}`),
  ].join("\n\n");
}
