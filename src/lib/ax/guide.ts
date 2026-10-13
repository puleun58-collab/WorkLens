import type { AxDiagnosis, AxPlan } from "./types";
import { automationLevel, axes, executionProfile, GATE_LABELS, type ExecutionGate, type ExecutionProfile, type StepScope } from "./policy";
import { FACTOR_KEYS } from "./schema";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: "npm install -g @openai/codex@latest", runCommand: "codex", doctorCommand: "codex doctor", loginNote: "첫 실행 시 ChatGPT 계정으로 로그인" },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "winget install --id Anthropic.ClaudeCode -e --source winget", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 브라우저에서 로그인" },
};

/** Inline text marks commands with backticks; `code` blocks default to PowerShell unless labeled as examples. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[]; notes?: string[]; label?: "PowerShell" | ".gitignore" | "예시" } | { kind: "steps"; items: string[] };
export interface AxGuideSection { title: string; when?: string; collapsed?: boolean; listStyle?: "bullets"; brand?: "vercel" | "cloudflare"; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; purpose: string; sections: AxGuideSection[] }

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (lines: string[], notes: string[], label?: Extract<AxGuideBlock, { kind: "code" }>["label"]): AxGuideBlock => ({ kind: "code", lines, notes, ...(label ? { label } : {}) });

export function setupGuide(tool: AxToolId): AxGuideStep[] {
  const guide = TOOL_GUIDES[tool];
  return [
    { title: "시작하기 전에 · 전체 흐름", purpose: `준비부터 Production 확인까지 ${guide.name} 작업 흐름`, sections: [
      { title: "처음 시작할 때", blocks: [
        text(`STEP 01에서 필요한 프로그램을 설치하고 Git·GitHub 인증과 ${guide.name} 연결을 확인합니다. 이미 설치된 항목은 건너뜁니다.`),
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
    { title: "STEP 01 · 개발 환경 준비", purpose: "필요한 프로그램을 설치하고 정상 설치와 계정 연결을 확인합니다.", sections: [
      { title: "필요한 프로그램 설치", blocks: [
        text("Windows PowerShell에서 아래 명령어로 필요한 프로그램을 설치하세요. 이미 설치된 프로그램은 건너뛰면 됩니다."),
        text("코드 변경 이력을 관리하고 GitHub와 프로젝트를 연결합니다."),
        code(["winget install --id Git.Git -e --source winget"], []),
        text("Node.js 기반 프로젝트 실행과 npm 개발 도구 설치에 사용합니다."),
        code(["winget install --id OpenJS.NodeJS.LTS -e --source winget"], [
          "프로젝트에 별도의 Node.js 버전 요구사항이 있으면 해당 요구사항을 우선합니다.",
        ]),
        text("GitHub 로그인과 저장소·PR 작업을 터미널에서 관리할 때 사용합니다."),
        code(["winget install --id GitHub.cli -e --source winget"], [
          "GitHub CLI는 권장 도구입니다. 기존 GitHub 인증 방식이 이미 정상이라면 설치를 강제하지 않습니다.",
        ]),
        text(`${guide.name} 설치`),
        code([guide.installCommand], [
          `설치 후 \`${guide.versionCommand}\`으로 확인합니다. 문제가 있으면 \`${guide.doctorCommand}\`으로 점검합니다.`,
        ]),
      ] },
      { title: "설치 확인", blocks: [
        text("설치 후 PowerShell을 새로 열고 정상 설치 여부를 확인하세요."),
        code(["git --version", "node --version", "npm --version", "gh --version", guide.versionCommand], [
          "실제로 필요하거나 설치한 프로그램의 확인 명령어만 실행합니다. 이미 설치된 프로그램의 재설치를 요구하지 않습니다.",
        ]),
      ] },
      { title: "Git 사용자 정보 설정", blocks: [
        text("커밋에 기록할 이름과 이메일을 확인합니다. 이미 설정되어 있다면 변경할 필요가 없습니다."),
        code(["git config user.name", "git config user.email"], [
          "현재 프로젝트에 적용되는 작성자 설정을 확인합니다. 값이 표시되면 변경하지 않습니다.",
        ]),
        text("비어 있을 때만 설정합니다."),
        code(['git config --global user.name "본인 GitHub 사용자명"', 'git config --global user.email "GitHub에 등록된 이메일"'], [
          "이름은 실제 GitHub 사용자명 또는 원하는 작성자 이름 사용",
          "이메일은 GitHub에 등록·인증된 이메일 사용 (GitHub 비공개 이메일도 사용 가능)",
          "예시 문구를 반드시 실제 정보로 바꾼 후 실행",
          "기존 값은 덮어쓰지 않음",
          "`--global`은 현재 PC 사용자 환경의 전체 Git 저장소에 적용됩니다.",
          "이메일 확인 경로: GitHub → Settings → Emails",
        ]),
      ] },
      { title: "GitHub 로그인 확인", blocks: [
        code(["gh auth status"], []),
        text("로그인되어 있지 않으면 아래 명령어의 안내를 따릅니다. 이미 로그인한 사용자에게 재인증을 요구하지 않습니다."),
        code(["gh auth login"], []),
        text("GitHub CLI를 사용하지 않는 환경에서는 기존 인증 방식을 유지합니다. 토큰·비밀번호를 가이드나 소스 코드에 직접 입력하도록 안내하지 않습니다."),
      ] },
      { title: `${guide.name} 로그인`, blocks: [
        code([guide.runCommand], []),
        text(guide.loginNote),
        text("GitHub 인증과 Codex·Claude Code 계정 인증은 별개입니다."),
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
        text("PowerShell에서 프로젝트 폴더로 이동한 뒤 코딩 에이전트를 실행하세요."),
        code(['cd "실제 프로젝트 경로"', guide.runCommand], [
          "실제 프로젝트 경로로 변경한 후 실행합니다.",
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
      { title: "Vercel인 경우", when: "현재 프로젝트가 Vercel에 배포되는 경우에만", brand: "vercel", blocks: [
        { kind: "steps", items: ["프로젝트 방식대로 push 또는 main merge", "Vercel build 결과 확인", "Preview 또는 Production 배포 확인", "배포 상태 확인"] },
        text("Git 연동 자동 배포라면 별도 수동 명령이 필요하지 않을 수 있습니다. 자동 배포에 수동 명령을 중복 실행하지 않습니다."),
        text("로컬 .env를 GitHub에 올리지 않고 Vercel Environment Variables에 설정합니다. 변수 이름은 프로젝트에서 확인합니다. Preview·Production 값을 따로 설정할 수 있습니다."),
        { kind: "steps", items: ["실패 시 배포 로그 확인", "민감정보를 가리고 필요한 로그만 AI 도구에 전달", "오류 수정", "테스트", "commit/push", "재배포 결과 확인"] },
      ] },
      { title: "Cloudflare인 경우", when: "현재 프로젝트가 Cloudflare에 배포되는 경우에만", brand: "cloudflare", blocks: [
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
  "담당자가 요청할 때 후보·초안을 제안하거나 진단 메모에 명시된 확인된 규칙을 보조적으로 처리하세요. 담당자 요청 없이 운영 업무가 무인·정기 자동 실행되거나 담당자 판단·승인을 대체하게 하지 마세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 Level 2~3 수준으로 확대하지 마세요.",
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
 * A quantified target is a confirmed business fact only when its number+unit AND its
 * measurement target both appear in the registration/diagnosis context. The same number
 * with a different meaning (e.g. 정산 오차율 0.5% vs 시스템 오류율 0.5%) is not confirmed.
 */
/** Every metric occurrence in the item, each verified against its own measurement target. */
const METRIC_GLOBAL = /(\d+(?:\.\d+)?\s*(?:%|퍼센트|배))/gu;
/** The noun phrase (up to 3 words) directly before a metric: the measurement target. */
const METRIC_SUBJECT_TAIL = /([가-힣A-Za-z]{2,}(?:\s+[가-힣A-Za-z]{2,}){0,2})\s*$/u;
/**
 * Deictic modifiers that never change what is measured. Quantitative modifiers
 * (목표/예상/평균/최대/최소/실제/기존값…) are deliberately kept: they can change the meaning.
 */
const NEUTRAL_SUBJECT_PREFIX = /^(?:기존|현재|해당)\s+/u;
const normalizeSubject = (subject: string) => subject.replace(/\s+/gu, " ").trim().replace(NEUTRAL_SUBJECT_PREFIX, "");
const normalizeMetric = (metric: string) => metric.replace(/퍼센트/u, "%").replace(/\s+/gu, "");
/** Words that change what a measurement means; never ignored when only one side has them. */
const MEANING_MODIFIER = /^(?:목표|예상|평균|최대|최소|실제|기준|표준|한도|상한|하한)$/u;
/** The core nouns of one subject are all present in the other: same measurement target, different wording. */
const subjectMatches = (itemSubject: string, ctxSubject: string) => {
  const wi = itemSubject.split(" ").filter(Boolean), wc = ctxSubject.split(" ").filter(Boolean);
  if (!wi.length || !wc.length) return false;
  if (wi.every(word => wc.includes(word))) return true;
  const extra = wi.filter(word => !wc.includes(word));
  return wc.every(word => wi.includes(word)) && extra.every(word => !MEANING_MODIFIER.test(word));
};
interface MetricClaim { text: string; subject: string; value: string; confirmed: boolean }
/** One claim per metric in the item; a confirmed first metric never covers the rest. */
function metricClaims(item: string, context: string): MetricClaim[] {
  return [...item.matchAll(METRIC_GLOBAL)].map(match => {
    const value = normalizeMetric(match[1]);
    const subject = normalizeSubject(METRIC_SUBJECT_TAIL.exec(item.slice(0, match.index))?.[1] ?? "");
    let confirmed = false;
    if (subject) {
      for (const ctx of context.matchAll(METRIC_GLOBAL)) {
        if (normalizeMetric(ctx[1]) !== value) continue;
        const ctxSubject = normalizeSubject(METRIC_SUBJECT_TAIL.exec(context.slice(0, ctx.index))?.[1] ?? "");
        if (ctxSubject && subjectMatches(subject, ctxSubject)) { confirmed = true; break; }
      }
    }
    return { text: `${METRIC_SUBJECT_TAIL.exec(item.slice(0, match.index))?.[1]?.trim() ?? ""} ${match[1]}`.trim(), subject, value, confirmed };
  });
}
/**
 * A quantified target is a confirmed business fact only when every metric in the item has its
 * number+unit AND its measurement target confirmed in the registration/diagnosis context.
 * The same number with a different meaning (e.g. 정산 오차율 0.5% vs 시스템 오류율 0.5%) is not confirmed.
 */
export function isConfirmedMetric(item: string, context: string): boolean {
  const claims = metricClaims(item, context);
  return claims.length > 0 && claims.every(claim => claim.confirmed);
}
/** System names before "API"; generic words are not an identifiable system. */
const API_SYSTEM = /([가-힣A-Za-z]+(?:\s+[가-힣A-Za-z]+){0,2})\s*API/giu;
const SYSTEM_STOP = /^(?:시스템|내부|외부|신규|기존|해당|관련|사내|전체|업무|전송|조회|읽기|등록|수정|삭제|승인|연동)$/u;
/** Last non-generic word of the phrase before "API": the system the API belongs to. */
const systemName = (phrase: string) => {
  const words = phrase.split(/\s+/u).filter(word => !SYSTEM_STOP.test(word));
  return words.length ? words[words.length - 1] : "";
};
const API_WRITE_OP = /(등록|생성|수정|삭제|전송|승인|결재|보정|반영|업로드|발행|확정)/u;
const API_READ_OP = /(조회|읽기|검색|확인|가져오|불러오|다운로드)/u;
/**
 * One confirmed API never confirms another: a read API does not grant write permission,
 * and system A's API says nothing about system B. Each system+operation is checked
 * independently against the context; confirmed normal reads are not blocked.
 */
function qualifyApi(value: string, item: string, context: string): string {
  if (!SYSTEM_INTERFACE.test(item) || /확인/u.test(item)) return value;
  const sentences = context.split(/[.\n。]/u);
  const sentenceHas = (name: string, op: RegExp) => sentences.some(sentence => sentence.includes(name) && op.test(sentence));
  let specific = false;
  for (const match of item.matchAll(API_SYSTEM)) {
    const system = systemName(match[1]);
    if (!system) continue;
    specific = true;
    const itemWrite = API_WRITE_OP.exec(item)?.[1];
    const itemRead = itemWrite ? undefined : API_READ_OP.exec(item)?.[1];
    if (itemWrite && !sentenceHas(system, API_WRITE_OP)) {
      value = `${value} ${UNCONFIRMED} ${system} API의 ${itemWrite} 기능과 실제 권한을 확인한 뒤 확인된 범위에서만 사용하세요)`;
    } else if (itemRead && !sentenceHas(system, API_READ_OP) && !sentenceHas(system, API_WRITE_OP)) {
      value = `${value} ${UNCONFIRMED} ${system} API의 ${itemRead} 가능 여부와 권한을 확인하세요)`;
    } else if (!sentences.some(sentence => sentence.includes(system))) {
      value = `${value} ${UNCONFIRMED} ${system} API의 존재·연동 방식·권한을 확인하세요)`;
    }
  }
  if (!specific && !SYSTEM_INTERFACE.test(context)) {
    value = `${value} ${UNCONFIRMED} 실제 연동 방식과 권한을 확인한 뒤 확인된 방식만 사용하세요)`;
  }
  return value;
}
/** The item carries metrics and none of them are confirmed: guardPlan drops it. */
function hasOnlyUnconfirmedMetrics(item: string, context: string): boolean {
  if (!UNSUPPORTED_METRIC.test(item)) return false;
  const claims = metricClaims(item, context);
  return claims.length > 0 && claims.every(claim => !claim.confirmed);
}

/**
 * Second line of defense after the generation prompt: keep grounded items, qualify plausible but unverified
 * ones in place, drop unsupported metrics. Qualified items carry the marker, so applying it twice changes nothing.
 */
export function guardPlan(plan: AxPlan, context: string): AxPlan {
  // A confirmed metric is preserved, but every other safety check still applies to the same sentence.
  // Each risk (auto action, unconfirmed API, unconfirmed org) is checked independently, so one
  // confirmed fact never suppresses the remaining checks.
  const guardItem = (item: string, qualify: boolean): string | null => {
    if (item.includes(UNCONFIRMED)) return item;
    if (UNSUPPORTED_METRIC.test(item)) {
      const claims = metricClaims(item, context);
      const unconfirmed = claims.filter(claim => !claim.confirmed);
      // Every metric unconfirmed: drop the performance goal as before.
      if (unconfirmed.length === claims.length) return null;
      // Partially confirmed: keep the original, but the unconfirmed metrics must not become criteria.
      // Remaining safety checks still apply below; the item is already marked, never marked twice.
      if (unconfirmed.length > 0) item = `${item} ${UNCONFIRMED} 다음 수치의 근거를 먼저 확인하세요: ${unconfirmed.map(claim => claim.text).join(", ")})`;
      // All metrics confirmed: the fact is preserved, remaining safety checks still apply below.
    }
    let value = item.replace(ORGANIZATION, org => context.includes(org) ? org : "담당 조직");
    const action = qualify ? AUTO_ACTION.exec(value)?.[1] : undefined;
    if (action && !new RegExp(`자동(?:으로)?\\s*${action}`, "u").test(context)) value = `${value} ${UNCONFIRMED} 업무 규칙에서 확인된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요)`;
    if (qualify) value = qualifyApi(value, item, context);
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

/** Ignore only presentation differences, never distinct conditions or different wording. */
const normalizedItem = (item: string) => item.trim()
  .replace(/^(?:(?:\d+[.)]|[①-⑳]|[-*•·])\s*)+/u, "")
  .replace(/\s+/gu, "")
  .replace(/[.。]$/u, "")
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
/** Prefixes stripped from 03 completion criteria when all items share the same unconfirmed status. */
const TEST_SCOPE_PREFIX = /^적용 범위 확인 필요\s*:\s*/u;
const CRITERION_PREFIX = /^기준 확인 필요\s*:\s*/u;
const FUTURE_TEST_PREFIX = /^향후 검증\s*:\s*/u;
const FUTURE_CRITERION_PREFIX = /^향후 판정\s*:\s*/u;
/** Content words of a completion-criteria text, used for conservative semantic duplicate comparison. */
const criteriaWords = (text: string): Set<string> => new Set(
  stripEnumerator(text)
    .replace(TEST_SCOPE_PREFIX, "").replace(CRITERION_PREFIX, "")
    .replace(FUTURE_TEST_PREFIX, "").replace(FUTURE_CRITERION_PREFIX, "")
    .toLowerCase()
    .split(/[\s·・,，.。、；;:\-—–/()（）"“”']+/u)
    .map(word => {
      if (CONFIRM_BOILERPLATE.has(word)) return "";
      for (const tail of ["미확인", "미확정", "여부", "필요"]) {
        if (word.endsWith(tail) && word.length > tail.length + 1) return word.slice(0, -tail.length);
      }
      return word;
    })
    .filter(Boolean)
);
/**
 * Conservative semantic dedup for 03 completion criteria.
 * Merges items only when one's content words are a subset of another's
 * (i.e., the shorter adds no new information). Items with distinct causes,
 * conditions, or actions are preserved.
 */
const dedupCriteria = (items: string[]): string[] => {
  const result: string[] = [];
  for (const item of items) {
    const words = criteriaWords(item);
    if (!words.size) continue;
    const isSubset = result.some(existing => {
      const existingWords = criteriaWords(existing);
      if (!existingWords.size) return false;
      // item's words are all in existing → item adds nothing new
      if ([...words].every(w => existingWords.has(w))) return true;
      // existing's words are all in item → existing adds nothing new; replace it
      if ([...existingWords].every(w => words.has(w))) {
        const idx = result.indexOf(existing);
        result[idx] = item;
        return true;
      }
      return false;
    });
    if (!isSubset && !result.includes(item)) result.push(item);
  }
  return result;
};
/** Presentation-only suffixes; the stage column and card badges already carry this meaning. */
const CONDITION_SUFFIX = /\s*\((?:적용 단계 확인 필요|향후 단계 조건)\)\s*$/u;
/** Words that only describe the confirmation act, never the condition itself. */
const CONFIRM_BOILERPLATE = new Set(["확인", "필요", "미확인", "미확정", "여부", "검토", "체크", "확정"]);
/** Content words of a condition text, used for conservative duplicate comparison against check cards. */
const conditionWords = (text: string): Set<string> => new Set(
  stripEnumerator(text).replace(CONDITION_SUFFIX, "").toLowerCase()
    .split(/[\s·・,，.。、；;:\-—–/()（）"“”']+/u)
    .map(word => {
      if (CONFIRM_BOILERPLATE.has(word)) return "";
      for (const tail of ["미확인", "미확정", "여부", "필요"]) {
        if (word.endsWith(tail) && word.length > tail.length + 1) return word.slice(0, -tail.length);
      }
      return word;
    })
    .filter(word => word.length > 1 && !CONFIRM_BOILERPLATE.has(word)),
);
/** An entry adds nothing when every content word already appears in the check card. Distinct conditions
 * (존재 여부 vs 접근 권한 vs 인증 방식) keep at least one uncovered word and are never merged. */
const coveredByCheck = (entryWords: Set<string>, checkWords: Set<string>) =>
  entryWords.size > 0 && [...entryWords].every(word => checkWords.has(word));
const shortConditionLabel = (text: string) => {
  const clean = stripEnumerator(text).replace(CONDITION_SUFFIX, "").replace(/\s+(?:확인이?\s*필요|미확인|확인)\s*$/u, "").trim();
  return clean || text;
};
/**
 * Conditions for the "추가 확인 사항" table: everything not already shown as a top check card.
 * Block reasons stay out (차단 사유 card). Diagnosis order is preserved; policy scopes are untouched.
 */
function buildAdditionalChecks(
  model: AgentInstructionModel,
  technicalChecks: AxDiagnosis["technicalChecks"],
  checkTexts: Set<string>,
  excludeTexts: Set<string>,
): AxAdditionalCheck[] {
  const checkWordSets = technicalChecks.map(check =>
    conditionWords(check.note ? `${check.topic} — ${check.note}` : check.topic));
  const isCheckDuplicate = (item: AgentInstructionItem | null, text: string): boolean => {
    if (item?.sources.includes("diagnosis.technicalChecks")) return true;
    const clean = text.replace(CONDITION_SUFFIX, "");
    if (checkTexts.has(normalizedItem(clean))) return true;
    const words = conditionWords(clean);
    return checkWordSets.some(checkWords => coveredByCheck(words, checkWords));
  };
  const toRow = (text: string, item: AgentInstructionItem | null, future: boolean): AxAdditionalCheck => {
    const content = text.replace(CONDITION_SUFFIX, "").trim();
    return {
      item: shortConditionLabel(content), content,
      stage: item?.step ?? null,
      status: future ? "향후 검토" : "확인 필요",
      tone: future ? "future" : "required",
      future,
    };
  };
  const rows: AxAdditionalCheck[] = [];
  const seen = new Set<string>();
  const push = (text: string, item: AgentInstructionItem | null, future: boolean) => {
    const key = normalizedItem(text.replace(CONDITION_SUFFIX, ""));
    if (!key || seen.has(key) || excludeTexts.has(key) || isCheckDuplicate(item, text)) return;
    seen.add(key);
    rows.push(toRow(text, item, future));
  };
  for (const item of model.conditions.current) push(item.text, item, false);
  for (const item of model.conditions.confirm) push(`${item.text} (적용 단계 확인 필요)`, item, false);
  for (const item of model.conditions.future) push(item.text, item, true);
  for (const text of model.gaps) push(text, null, false);
  return rows;
}
/** Step relation normalization preserves interior word boundaries unlike general item dedupe. */
const normalizedStepText = (value: string) => value.trim().replace(/\s+/gu, " ").replace(/[.。]\s*$/u, "").trim();
const explicitStep = (value: string, step: StepScope) => {
  const clean = normalizedStepText(value), name = normalizedStepText(step.step);
  if (!name) return false;
  if (clean === name) return true;
  const delimiter = /\s+[—–-]\s+|:\s+/u.exec(clean);
  if (delimiter && normalizedStepText(clean.slice(0, delimiter.index)) === name) return true;
  return !!step.treatment && clean === normalizedStepText(`${step.step} ${step.treatment}`);
};
const HUMAN_DECISION_CHECK = "담당자 유지 항목의 확정·시스템 반영·외부 전송 조건을 해당 단계에서 확인하세요. 확인 전 최종 처리는 대기하지만, 허용된 독립 후보·초안·규칙 검토는 각 단계의 선행 조건 안에서 진행할 수 있습니다.";
/** Card tone for one technical check; `future` only when the check is explicitly linked to a step outside the current Level scope. */
export type AxCheckTone = "required" | "future" | "done" | "blocked";
/** One row of the "추가 확인 사항" table: a condition not already shown as a top check card. */
export interface AxAdditionalCheck {
  /** Short label for the 확인 항목 column. */
  item: string;
  /** Full detail for the 확인 필요 내용 column. */
  content: string;
  /** Linked diagnosis step, or null when the stage link is unconfirmed (never guessed). */
  stage: string | null;
  status: "확인 필요" | "확인됨" | "향후 검토" | "불가";
  tone: AxCheckTone;
  future: boolean;
}
/** Read-only Step 4 summary; tentative PoC claims are visible but never promoted to required checks. */
export interface AxPlanSummary {
  include: string[]; humanKept: string[]; excluded: string[];
  prerequisites: string[];
  /** Technical checks as status cards, in diagnosis order. */
  checks: { topic: string; status: AxDiagnosis["technicalChecks"][number]["status"]; note: string; tone: AxCheckTone }[];
  /** Block reasons, shown as the 차단 사유 card; never mixed into the additional-checks table. */
  blockReasons: string[];
  /** Conditions not already shown as a check card, with stage linkage kept explicit. */
  additionalChecks: AxAdditionalCheck[];
  /** Prerequisites not already shown as a check card; blocked gates list block reasons as `current`. */
  conditions: { current: string[]; future: string[] };
  /** Existing structured human/exclusion fields, with their source retained. */
  constraints: string[];
  /** Constraints whose item is not already listed in `humanKept` or `excluded`. */
  approvals: string[];
  data: { label: string; items: string[] }[];
  tests: string[]; success: string[]; failure: string[]; exceptions: string[];
  /** Common notice when all tests share the same unconfirmed scope; individual prefixes are stripped. */
  testsNotice?: string;
  /** Common notice when all criteria share the same unconfirmed status; individual prefixes are stripped. */
  criteriaNotice?: string;
}

export function planSummary(diagnosis: AxDiagnosis, rawPlan?: AxPlan, context = ""): AxPlanSummary {
  const model = buildAgentInstructionModel(rawPlan, { diagnosis, context });
  const profile = model.profile;
  const humanKept = mergeDistinct((profile?.manualSteps ?? []).map(step => `${step} (담당자 수행)`),
    model.classified.filter(item => item.role === "human").map(item => item.original ?? item.text));
  const scopeLevel = model.scopeLevel;
  const restricted = [
    ...(scopeLevel !== undefined && scopeLevel >= 2 ? [] : (profile?.automationSteps ?? []).map(step => `${step} 자동 실행`)),
    ...(scopeLevel !== undefined && scopeLevel >= 1 ? [] : (profile?.assistSteps ?? []).map(step => `${step} AI 보조 구현`)),
  ];
  const manualAutomation = (profile?.manualSteps ?? []).map(step => `${step} 자동화 (담당자 수행)`);
  const conditionEntries = [
    ...(model.gate === "blocked" ? profile?.blockReasons ?? [] : []).map(text => ({ text, future: false })),
    ...model.conditions.current.map(item => ({ text: item.text, future: false })),
    ...model.conditions.confirm.map(item => ({ text: `${item.text} (적용 단계 확인 필요)`, future: false })),
    ...model.conditions.future.map(item => ({ text: item.text, future: true })),
    ...model.gaps.map(text => ({ text, future: false })),
  ];
  const prerequisites = unique(conditionEntries.map(entry => entry.future ? `${entry.text} (향후 단계 조건)` : entry.text));
  const technicalChecks = diagnosis.technicalChecks ?? [];
  const checkTexts = new Set(technicalChecks.flatMap(check => [
    check.note ? `${check.topic} — ${check.note}` : check.topic,
    ...(check.status === "불가" ? [check.note ? `${check.topic} 불가 — ${check.note}` : `${check.topic} 불가`] : []),
  ]).map(normalizedItem));
  const openConditions = conditionEntries.filter(entry => !checkTexts.has(normalizedItem(entry.text.replace(/ \(적용 단계 확인 필요\)$/u, ""))));
  const checks = technicalChecks.map(check => {
    const text = `${check.topic}${check.note ? ` — ${check.note}` : ""}`;
    const linked = model.classified.find(item => item.sources.includes("diagnosis.technicalChecks") && item.text === text);
    const tone: AxCheckTone = check.status === "확인됨" ? "done" : check.status === "불가" ? "blocked" : linked?.scope === "future" ? "future" : "required";
    return { topic: check.topic, status: check.status, note: check.note, tone };
  });
  const additionalChecks = buildAdditionalChecks(model, technicalChecks, checkTexts,
    new Set((model.gate === "blocked" ? profile?.blockReasons ?? [] : []).map(normalizedItem)));
  const excluded = mergeDistinct(restricted, without([
    ...(profile?.poc.outOfScope ?? []), ...model.classified.filter(item => item.role === "excluded").map(item => item.original ?? item.text),
  ], [...manualAutomation, ...humanKept]));
  const shownScope = new Set([...humanKept, ...excluded].map(normalizedItem));
  const pocTests = model.classified.filter(item => item.role === "tests");
  const criteria = (source: string) => unique(model.classified.filter(item => item.sources.includes(source) && !model.scoped.validationMethods.includes(item)).map(item => model.scoped.criteria.includes(item)
    ? item.text : `${item.scope === "future" ? "향후 판정" : "기준 확인 필요"}: ${item.text}`));
  return {
    include: unique((profile?.poc.inScope ?? []).flatMap(line => {
      const matches = model.steps.map((step, index) => ({ step, index }))
        .filter(({ step }) => step.treatment && normalizedStepText(`${step.step} ${step.treatment}`) === normalizedStepText(line));
      return matches.length > 1
        ? matches.map(({ step, index }) => `${step.step} ${stepMethodLabel(model, index)} (진단 단계 ${index + 1}; 진단 메모: ${step.note || "없음"})`)
        : [scopeItemLabel(model, line)];
    })),
    humanKept,
    excluded,
    prerequisites,
    checks,
    blockReasons: model.gate === "blocked" ? [...(profile?.blockReasons ?? [])] : [],
    additionalChecks,
    conditions: {
      current: unique(openConditions.filter(entry => !entry.future).map(entry => entry.text)),
      future: unique(openConditions.filter(entry => entry.future).map(entry => entry.text)),
    },
    constraints: approvalConstraints(model),
    approvals: approvalConstraints(model, entry => !shownScope.has(normalizedItem(entry.original ?? entry.text)) && !shownScope.has(normalizedItem(entry.text))),
    data: [
      { label: "입력", items: unique(diagnosis.asIs?.inputs ?? []) },
      { label: "출력", items: unique((diagnosis.asIs?.outputs ?? []).map(text => `${text} (기존 업무 출력·참고)`)) },
      { label: "사용 시스템", items: unique(diagnosis.asIs?.systems ?? []) },
      { label: "검증용 입력", items: without(diagnosis.poc?.inputs ?? [], diagnosis.asIs?.inputs ?? []) },
      { label: "검증용 출력", items: unique(model.classified.filter(item => item.sources.includes("diagnosis.poc.outputs")).map(item => `${item.text}${model.scoped.outputs.includes(item) ? item.scope === "after-check" ? " (현재 조건부 출력)" : " (현재 출력)" : item.scope === "future" ? " (향후 출력)" : " (연결 근거 확인 필요)"}`)) },
    ].filter(row => row.items.length),
    ...completionCriteria(model, pocTests, criteria, diagnosis),
  };
}

/**
 * 03 완료 기준: repeated unconfirmed-status prefixes are folded into a single
 * common notice, and semantically duplicate items are merged. Original data,
 * Level × Gate policy, and the all-in-one prompt (which reads the model
 * directly) are unchanged — this only affects the summary presentation.
 */
function completionCriteria(
  model: AgentInstructionModel,
  pocTests: AgentInstructionItem[],
  criteria: (source: string) => string[],
  diagnosis: AxDiagnosis,
): Pick<AxPlanSummary, "tests" | "success" | "failure" | "exceptions" | "testsNotice" | "criteriaNotice"> {
  const rawTests = unique([...pocTests.map(item => model.scoped.tests.includes(item) ? item.text
    : `${item.scope === "future" ? "향후 검증" : "적용 범위 확인 필요"}: ${item.text}`), ...model.scoped.validationMethods.map(item => item.text)]);
  const rawSuccess = mergeDistinct(criteria("diagnosis.poc.success"), criteria("plan.acceptance"));
  const rawFailure = criteria("diagnosis.poc.failure");
  // Fold the repeated "적용 범위 확인 필요:" prefix into one notice when every
  // test item shares that unconfirmed status (mixed confirmed/unconfirmed stays explicit).
  let tests = rawTests;
  let testsNotice: string | undefined;
  if (tests.length > 1 && tests.every(item => TEST_SCOPE_PREFIX.test(item))) {
    tests = tests.map(item => item.replace(TEST_SCOPE_PREFIX, ""));
    testsNotice = "검증 대상 단계와 적용 범위는 확인이 필요합니다.";
  }
  // Same for the "기준 확인 필요:" prefix on pass/fail criteria.
  let success = rawSuccess;
  let failure = rawFailure;
  let criteriaNotice: string | undefined;
  const unconfirmed = (items: string[]) => items.length > 1 && items.every(item => CRITERION_PREFIX.test(item));
  if (unconfirmed(success) && unconfirmed(failure)) {
    success = success.map(item => item.replace(CRITERION_PREFIX, ""));
    failure = failure.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  } else if (unconfirmed(success)) {
    success = success.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 합격 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  } else if (unconfirmed(failure)) {
    failure = failure.map(item => item.replace(CRITERION_PREFIX, ""));
    criteriaNotice = "정확한 실패 판정 기준은 실제 업무 규칙 확인 후 확정합니다.";
  }
  return {
    tests: dedupCriteria(tests),
    success: dedupCriteria(success),
    failure: dedupCriteria(failure),
    exceptions: dedupCriteria(unique([...(diagnosis.asIs?.exceptions ?? []), ...(diagnosis.risks ?? []), ...model.classified.filter(item => item.role === "exception").map(item => item.text)])),
    ...(testsNotice ? { testsNotice } : {}),
    ...(criteriaNotice ? { criteriaNotice } : {}),
  };
}

/** Comparative targets need an expected result before they can pass or fail. */
const VAGUE_CRITERION = /감소|증가|개선|단축|향상|최소화|최대화/u;
const SCOPE_TITLES = { implement: "이번 구현", "after-check": "확인 후 구현", verify: "검토·검증만" } as const;
const stripEnumerator = (item: string) => item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "").trim();
/** An explicit test label in a feature field marks a scenario, not a feature. */
const TEST_LABEL = /^(?:테스트(?:\s*시나리오)?|(?:정상|경계|경계값|실패|예외|오류)\s*(?:케이스|사례|시나리오)?)\s*:/u;
/** Level 1 never runs unattended; a proposal describing that method needs confirmation, not authorization. */
const UNATTENDED_METHOD = /(무인|자동\s*(?:생성|작성|실행|전송|발행|승인|확정|수집|계산))/u;
const REQUESTED = /(담당자 요청|담당자 확인 후|수동 요청|요청 시)/u;
const RULE_NOTE = /(규칙\s*기반|확정된 규칙|정해진 규칙|알고리즘|계산식(?:을|에 따라))/u;
const SCRIPT_NOTE = /(?:스크립트|프로그램|시스템).*(?:파일|데이터|자료).*(?:읽|병합|취합|추출)|(?:API|SDK)\s*(?:호출|연동)/iu;
const CANDIDATE_NOTE = /(?:AI(?:로|가|는|은|을|를|와|과)?(?:\s+\S+){0,3}?\s*(?:후보|초안|생성|모델|처리)|인공지능|언어\s*모델|LLM|(?:후보|초안)(?:\s*·\s*(?:후보|초안))?\s*(?:생성|제안|검토)|후보와 변환 결과)/iu;
const MANUAL_NOTE = /(?:담당자|사람)(?:가|이)\s*[^,.;]{0,30}?(?:직접|수동으로)?\s*(?:처리|검토|판단|작성|승인|확인|확정)/u;
const VALIDATION_METHOD = /대조|비교|기록/u;
const PASS_CONDITION = /통과|(?<!불)일치|동일|모두|빠짐없이|않(?:아야|음)|없(?:어야|음)|실패|정상.*(?:섞|처리)|분리/u;
/** Level 0 permits no system integration or AI implementation, so a check about one cannot gate the current review work. */
const INTEGRATION_CHECK = /(API|연동|인증|라이선스|AI\s*(?:모델|서비스|엔진)|생성\s*모델|외부\s*시스템|자동\s*(?:저장|전송|업로드))/iu;
/** A Level 0 review has no automated or AI output to compare against. */
const AUTOMATED_RESULT = /(?:자동|AI|인공지능)\s*(?:생성|작성|초안|결과|처리|판단|판정|분류|추출)/iu;
export interface AgentInstructionItem {
  /** First source field; `sources` lists every field that carried the same item. */
  source: string;
  sources: string[];
  role: string;
  text: string;
  /** Raw wording when the plan guard qualified or replaced part of it. */
  original?: string;
  /** Original variants retained when presentation duplicates share a classification. */
  originals: string[];
  scope: StepScope["scope"] | "confirm" | "excluded";
  step?: string;
  reason?: string;
}
/** Actual processing evidence, independent of the Level/Gate execution restriction. */
export type StepMethod = "assist" | "rule" | "script" | "manual" | "confirm" | "composite";
export interface AgentInstructionModel {
  profile?: ExecutionProfile;
  level?: { level: number; label: string; provisional: boolean };
  gate?: ExecutionGate;
  scopeLevel?: number;
  /** Policy step scope, unchanged and in diagnosis order. */
  steps: StepScope[];
  /** Index-aligned with `steps`; explicit diagnosis note evidence only, never inferred from policy/verdict. */
  methods: StepMethod[];
  methodReasons: string[];
  /** Index-aligned with `steps`; the ordered roles of a composite method, or undefined. */
  methodChains: (StepMethod[] | undefined)[];
  /** Index-aligned with `steps`; execution order of a composite method: explicit sequence or parallel. */
  methodOrders: (MethodOrder | undefined)[];
  conditions: { current: AgentInstructionItem[]; future: AgentInstructionItem[]; global: AgentInstructionItem[]; confirm: AgentInstructionItem[] };
  classified: AgentInstructionItem[];
  ambiguous: AgentInstructionItem[];
  scoped: { features: AgentInstructionItem[]; tests: AgentInstructionItem[]; criteria: AgentInstructionItem[]; validationMethods: AgentInstructionItem[]; outputs: AgentInstructionItem[]; conditions: AgentInstructionItem[] };
  diagnosis?: AxDiagnosis;
  plan?: AxPlan;
  prerequisites: string[];
  gaps: string[];
}
/** Strong markers of an explicit execution order; weak connectors need an explicit actor to count. */
const STRONG_SEQUENCE = /(먼저|다음|그\s*뒤|뒤에|그\s*후|후에|한\s*뒤|→|이후|그다음)/u;
const PARALLEL_WORD = /(병행|동시에|나란히)/u;
const WEAK_SEQUENCE = /(그리고|하고|이어서)/u;
/** An explicit actor as grammatical subject after a weak connector signals a real sequence. */
const ACTOR_SUBJECT = /(담당자|사람|AI|시스템)(가|이|는|은)/u;
/** Order of a composite flow: an explicit sequence, or an explicit parallel execution. */
export type MethodOrder = "sequence" | "parallel";
/** Ordered processing roles inside one evidence text, by first occurrence. */
const methodsIn = (text: string): StepMethod[] => {
  const ordered: { method: StepMethod; at: number }[] = [];
  const push = (method: StepMethod, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (match) ordered.push({ method, at: match.index ?? 0 });
  };
  push("rule", RULE_NOTE); push("script", SCRIPT_NOTE); push("assist", CANDIDATE_NOTE); push("manual", MANUAL_NOTE);
  return [...new Set(ordered.sort((a, b) => a.at - b.at).map(entry => entry.method))];
};
function stepMethod(s: StepScope, duplicate: boolean, diagnosis?: AxDiagnosis): { method: StepMethod; reason: string; chain?: StepMethod[]; order?: MethodOrder } {
  if (duplicate) return { method: "confirm", reason: "동일 이름의 진단 단계 중복: 적용 단계 확인 필요" };
  if (s.scope === "human") return { method: "manual", reason: s.note };
  // Owner/verdict describe responsibility and policy, not an implementation-method enum.
  // Only exactly linked descriptions contribute evidence; similar names never establish a relation.
  const evidence = [
    ...(s.note ? [{ source: "diagnosis.stepAssessments.note", text: s.note }] : []),
    ...(diagnosis?.toBe ?? []).filter(item => normalizedStepText(item.step) === normalizedStepText(s.step))
      .map(item => ({ source: "diagnosis.toBe.description", text: item.description })),
  ];
  const reason = evidence.map(item => `${item.source}: ${item.text}`).join("; ");
  const itemChains = evidence.map(item => ({ item, chain: methodsIn(item.text) }));
  const all = methodsIn(evidence.map(item => item.text).join("\n"));
  const processing = (chain: StepMethod[]) => chain.filter(method => method !== "manual");
  // A confirmed composite is one coherent statement: distinct processing roles with either an
  // explicit order (sequential) or an explicit parallel relation. Mere enumeration never
  // establishes an order, and the same processing role described differently by different
  // sources is a conflict, not a composite.
  const orderOf = (text: string, chain: StepMethod[]): MethodOrder | undefined => {
    if (chain.length < 2 || processing(chain).length < 1) return undefined;
    if (PARALLEL_WORD.test(text)) return "parallel";
    if (STRONG_SEQUENCE.test(text)) return "sequence";
    const weak = WEAK_SEQUENCE.exec(text);
    if (weak && ACTOR_SUBJECT.test(text.slice(weak.index + weak[0].length))) return "sequence";
    return undefined;
  };
  const sequenced = itemChains
    .map(({ item, chain }) => ({ item, chain, order: orderOf(item.text, chain) }))
    .find(entry => entry.order);
  if (sequenced) {
    const chain = sequenced.chain;
    const consistent = itemChains.every(({ chain: other }) => processing(other).every(method => processing(chain).includes(method)));
    if (consistent) return { method: "composite", reason, chain, order: sequenced.order };
    return { method: "confirm", reason: ["처리 방식 근거 충돌", reason].filter(Boolean).join("; ") };
  }
  if (all.length > 1 && processing(all).length >= 2) return { method: "confirm", reason: ["처리 방식 근거 충돌", reason].filter(Boolean).join("; ") };
  const method = processing(all).length === 1 ? processing(all)[0] : all.length === 1 ? all[0] : "confirm";
  return { method, reason: [method === "confirm" && !all.length ? "명시적 처리 방식 확인 필요" : "", reason].filter(Boolean).join("; ") };
}
/** Short user-facing name of one processing role inside a composite chain. */
export function stepMethodShortLabel(method: StepMethod): string {
  return method === "rule" ? "규칙 기반 처리" : method === "script" ? "일반 시스템·스크립트 처리"
    : method === "assist" ? "AI 후보·초안 생성" : method === "manual" ? "담당자 확인" : "처리 방식 확인 필요";
}
/** One user-facing processing label shared across timeline, summary and prompt. */
export function stepMethodLabel(model: AgentInstructionModel, index: number): string {
  const step = model.steps[index];
  if (!step) return "처리 방식 확인 필요";
  const method = model.methods[index];
  const chain = model.methodChains[index];
  if (method === "composite" && chain?.length) {
    const order = model.methodOrders[index];
    const verifySuffix = step.scope === "verify" ? " · 검토·검증만 (운영 구현 금지)" : "";
    if (order === "parallel") {
      const parts = chain.map(stepMethodShortLabel).join(" · ");
      return `복합 처리 (병행): ${parts} — 실행 순서·의존성 확인 필요${verifySuffix}`;
    }
    const ordered = chain.map(stepMethodShortLabel).join(" → ");
    return `복합 처리 (확인된 순서): ${ordered}${verifySuffix}`;
  }
  const processing = method === "rule" ? "규칙 기반 처리 (구체 규칙 확인 필요)" : method === "script" ? "일반 시스템·스크립트 처리" : method === "assist" ? "AI 후보·초안 생성" : method === "manual" ? "담당자 수동 처리" : "처리 방식 확인 필요";
  if (step.scope === "verify") return `${processing} · 검토·검증만 (운영 구현 금지)`;
  if (step.scope === "human") return "담당자 수행 유지 (자동화·판단 대체 금지)";
  if (method === "confirm") return model.steps.filter(s => normalizedStepText(s.step) === normalizedStepText(step.step)).length > 1
    ? "동일 이름의 진단 단계 중복: 처리 방식·적용 단계 확인 필요"
    : `처리 방식 확인 필요 (확인 전 방식 선택·구현 금지)${model.methodReasons[index] ? ` — ${model.methodReasons[index]}` : ""}`;
  if (method === "assist") return "AI 후보·초안 생성 (담당자 확정 전 운영 반영 금지)";
  if (method === "manual") return "담당자 수동 처리 (시스템 구현 전 역할·범위 확인 필요)";
  if (method === "script") return model.scopeLevel === 1
    ? "일반 시스템·스크립트 처리 (담당자 요청 시 실행·형식·병합 키·예외 기준 확인 후 구현)"
    : "일반 시스템·스크립트 처리 (형식·업무 규칙 확인 후 구현)";
  return model.scopeLevel === 1
    ? "규칙 기반 처리 (규칙 확인 후 담당자 요청 시 실행·결과는 담당자 확인 후 확정)"
    : "규칙 기반 처리 (규칙 확인 후 구현·예외는 담당자 확인)";
}
/** Rewrite an exact policy-generated step/treatment line, leaving support and narrative text untouched. */
export function scopeItemLabel(model: AgentInstructionModel, text: string): string {
  const prefix = text.startsWith("샘플 범위: ") ? "샘플 범위: " : "";
  const line = prefix ? text.slice(prefix.length) : text;
  const matches = model.steps.map((step, index) => ({ step, index }))
    .filter(({ step }) => step.treatment && normalizedStepText(`${step.step} ${step.treatment}`) === normalizedStepText(line));
  if (matches.length > 1) return `${prefix}${matches[0].step.step} 동일 이름의 진단 단계 중복: 처리 방식·적용 단계 확인 필요 (진단 단계 ${matches.map(({ index }) => index + 1).join(", ")})`;
  return matches.length === 1 ? `${prefix}${matches[0].step.step} ${stepMethodLabel(model, matches[0].index)}` : text;
}
/** Existing human/exclusion fields are restrictive evidence; preserve wording and provenance. */
export function approvalConstraints(model: AgentInstructionModel, keep: (item: AgentInstructionItem) => boolean = () => true): string[] {
  const entries = model.classified.filter(item => item.role === "human" || item.role === "excluded")
    .filter(item => item.sources.some(source => source === "diagnosis.humanInLoop" || source === "diagnosis.poc.outOfScope"
      || source === "plan.humanInLoop" || source === "plan.outOfScope" || source === "policy.manualSteps"))
    .filter(keep);
  return unique(entries.map(item => `${item.original ?? item.text}${item.original ? ` (현재 계획 문구: ${item.text})` : ""}`));
}
type PromptOptions = { taskName?: string; prerequisites?: string[]; diagnosis?: AxDiagnosis; context?: string };
const PLAN_ROLES: Record<Exclude<keyof AxPlan, "repositoryFirst">, string> = {
  goal: "goal", asIs: "reference", toBe: "reference", inScope: "features", outOfScope: "excluded",
  prerequisites: "conditions", humanInLoop: "human", poc: "reference", implementation: "features",
  dataFlow: "flow", integrations: "conditions", exceptions: "exception", fallback: "fallback",
  security: "security", operation: "operation", tests: "tests", acceptance: "criteria",
};

/** Derive one read-only scope before rendering; narrative evidence cannot enlarge a policy step. */
export function buildAgentInstructionModel(rawPlan: AxPlan | undefined, options: PromptOptions = {}): AgentInstructionModel {
  const d = options.diagnosis;
  // Old sparse runtime records must not acquire a fabricated Level or Gate through defaults.
  const validFactors = d?.factors?.length === FACTOR_KEYS.length && FACTOR_KEYS.every(key => d.factors.some(f => f.key === key && Number.isFinite(f.aiValue)));
  const validGate = d?.decisionGate && ["go", "conditional", "no-go"].includes(d.decisionGate.verdict)
    && ["sufficient", "partial", "needs-check"].includes(d.informationSufficiency);
  const safe = d && validFactors && validGate ? {
    ...d,
    asIs: { purpose: "", trigger: "", inputs: [], outputs: [], steps: [], exceptions: [], systems: [], humanDecisions: [], ...(d.asIs as Partial<AxDiagnosis["asIs"]> | undefined) },
    stepAssessments: d.stepAssessments ?? [], toBe: d.toBe ?? [], humanInLoop: d.humanInLoop ?? [],
    technicalChecks: d.technicalChecks ?? [], risks: d.risks ?? [], followUpQuestions: d.followUpQuestions ?? [],
    poc: { hypothesis: "", inScope: [], outOfScope: [], inputs: [], outputs: [], evaluation: [], success: [], failure: [], ...(d.poc as Partial<AxDiagnosis["poc"]> | undefined) },
    decisionGate: { ...d.decisionGate, reasons: d.decisionGate.reasons ?? [] },
    operation: { owner: "", failureOwner: "", maintenanceBurden: "medium" as const, fallback: "", notes: [], ...(d.operation as Partial<AxDiagnosis["operation"]> | undefined) },
  } as AxDiagnosis : undefined;
  const profile = safe ? executionProfile(safe) : undefined;
  const level = safe ? automationLevel(safe) : undefined;
  const gate = profile?.gate;
  const scopeLevel = profile ? gate === "blocked" ? 0 : profile.level : undefined;
  const steps = profile?.stepScope ?? [];
  const guarded = rawPlan ? guardPlan(rawPlan, [options.taskName ?? "", options.context ?? ""].join("\n")) : undefined;
  const classified: AgentInstructionItem[] = [];
  const closed = new Set([
    ...(profile?.poc.outOfScope ?? []), ...(d?.humanInLoop ?? []), ...(rawPlan?.outOfScope ?? []), ...(rawPlan?.humanInLoop ?? []),
    ...steps.filter(s => s.scope === "human").flatMap(s => [s.step, `${s.step} 자동화`, `담당자 ${s.step}`, `${s.step} (담당자 수행)`]),
  ].map(normalizedItem));
  const append = (source: string, role: string, text: string, override?: string, original?: string) => {
    if (!text?.trim()) return;
    // A whole technical-check topic is stable source evidence, not a substring-based step guess.
    if (role === "conditions" && source !== "diagnosis.technicalChecks") {
      const checks = (d?.technicalChecks ?? []).filter(check =>
        [check.topic, `${check.topic} 확인`, `${check.topic}${check.note ? ` — ${check.note}` : ""}`].some(value => normalizedItem(value) === normalizedItem(text)));
      if (checks.length === 1) {
        const check = checks[0];
        original ??= text;
        text = `${check.topic}${check.note ? ` — ${check.note}` : ""}`;
        if (check.status === "확인됨") { role = "reference"; override = "이미 확인된 기술 조건 (참고)"; }
      }
    }
    let clean = stripEnumerator(text);
    if (role === "human" && /(?:승인|판단|결재|확정)\s*자동화|자동\s*(?:승인|판단|결재|확정)/u.test(clean)) role = "excluded";
    if (["features", "goal"].includes(role) && TEST_LABEL.test(clean)) {
      role = "tests";
      // A bare "테스트:" label adds nothing; 정상·경계·실패 labels name the case type and stay.
      clean = clean.replace(/^테스트(?:\s*시나리오)?\s*:\s*/u, "");
    }
    const relation = normalizedStepText(clean.replace(/\s*\(확인 필요:[^)]*\)\s*$/u, ""));
    if (source === "plan.poc") {
      const field = /^(?:PoC\s*)?(성공|실패|평가|검증|출력)\s*:/iu.exec(clean)?.[1];
      if (field === "성공" || field === "실패") role = "criteria";
      else if (field === "평가" || field === "검증") role = "tests";
      else if (field === "출력") role = "outputs";
    }
    // Only a whole name or an explicit name-prefix relation links a step; check topics are not step IDs.
    // A detail that itself starts with another whole diagnosed name makes the relation ambiguous.
    const directMatches = steps.filter(s => explicitStep(relation, s));
    const detail = relation.split(/\s+[—–-]\s+|:\s+/u).slice(1).join(" ");
    const otherMatches = directMatches.length === 1 && detail ? steps.filter(s => s !== directMatches[0]
      && normalizedStepText(s.step) && (detail === normalizedStepText(s.step) || detail.startsWith(`${normalizedStepText(s.step)} `))) : [];
    const matches = [...directMatches, ...otherMatches];
    // A bare-space prefix is NOT a link. It only prevents an unlinked PoC item from silently
    // becoming a current required check when it may instead describe future/human work.
    const deferredMention = !matches.length ? steps.filter(s => (s.scope === "future" || s.scope === "human")
      && normalizedStepText(s.step) && relation.startsWith(`${normalizedStepText(s.step)} `)) : [];
    let scope: AgentInstructionItem["scope"] = "confirm";
    let reason: string | undefined;
    if (closed.has(normalizedItem(relation)) || role === "excluded" || role === "human") {
      scope = "excluded";
      reason = role === "human" ? "담당자 수행 유지" : "현재 자동화 제외";
    } else if (source === "diagnosis.asIs.outputs") {
      scope = matches.length === 1 && matches[0].scope === "future" ? "future" : "confirm";
      reason = "기존 업무의 전체 출력·참고: 현재 생성 단계와 재사용 조건 확인 전 필수 출력 아님";
    } else if (override) {
      reason = override;
    } else if (scopeLevel === 0 && !matches.length && (source === "diagnosis.technicalChecks" || source.startsWith("plan.")) && role === "conditions" && INTEGRATION_CHECK.test(clean)) {
      scope = "future";
      reason = `${gate === "blocked" ? "진행 보류 상태(검토·검증만 허용)" : "Level 0"}에서는 시스템 연동·AI 구현을 하지 않아 현재 검토·검증의 선행 조건이 아님 (전체 실행 상태는 그대로 적용)`;
    } else if (scopeLevel === 0 && ["tests", "criteria", "outputs"].includes(role) && AUTOMATED_RESULT.test(clean)) {
      scope = "future";
      reason = `${gate === "blocked" ? "진행 보류 상태" : "Level 0"}에는 자동·AI 결과물이 없음: 검증·출력을 위해 생성 기능을 만들지 말고, 기존 비교 자료가 없으면 검증 불가 사유를 기록`;
    } else if (scopeLevel === 0 && ["features", "goal"].includes(role) && source.startsWith("plan.") && !(matches.length === 1 && matches[0].scope === "human")) {
      // Level 0 and a blocked gate permit review only: no generated feature is implementable, linked or not.
      scope = "future";
      reason = gate === "blocked" ? "진행 보류 상태" : "Level 0은 검토·검증만 허용";
    } else if (deferredMention.length && source.startsWith("diagnosis.poc.")
      && ["tests", "criteria", "outputs"].includes(role)) {
      reason = `향후·담당자 단계 이름으로 시작하나 명시적 연결 없음 (${deferredMention.map(s => s.step).join(", ")}): 현재 PoC 필수 항목으로 승격 금지`;
    } else if (!matches.length && ["outputs", "tests", "criteria"].includes(role)) {
      reason = "생성·검증 대상 단계의 연결 근거 확인 필요: 업무 전체 산출물·PoC 문구만으로 현재 필수 항목으로 승격하지 않음";
    } else if (matches.length !== 1) {
      reason = matches.length ? "여러 진단 단계에 연결되어 적용 범위를 확인해야 합니다." : source === "diagnosis.technicalChecks" ? "적용 단계 미확인: 전역 Gate 조건은 계속 유효합니다." : "연결된 진단 단계가 확인되지 않았습니다.";
    } else {
      scope = matches[0].scope;
      if (scope === "future") reason = `현재 Level ${scopeLevel} 범위 밖`;
      if (scope === "human") reason = "담당자 수행 단계";
      if (scope === "verify") reason = gate === "blocked" ? "진행 보류 상태" : "검토·검증만 허용";
      // A permitted Level 1 step keeps its policy scope; an unattended method proposed for it is held for confirmation.
      if (scopeLevel === 1 && (scope === "implement" || scope === "after-check") && ["features", "goal"].includes(role)
        && UNATTENDED_METHOD.test(clean) && !REQUESTED.test(clean)) {
        scope = "confirm";
        reason = "Level 1은 담당자 요청 없는 무인 실행·자동 확정을 허용하지 않습니다. 담당자 요청 기반 후보·초안 방식으로 적용할 수 있는지 확인하세요.";
      }
    }
    if (["criteria", "tests"].includes(role) && UNSUPPORTED_METRIC.test(clean)) {
      scope = "confirm";
      reason = "수치 기준 확인 필요: 측정 대상·방법·데이터 범위·비교 기준·판정 근거가 확인되지 않음";
    }
    const step = matches.length === 1 ? matches[0].step : undefined;
    const same = matches.length > 1 ? undefined : classified.find(item => item.role === role && item.scope === scope && item.step === step && normalizedItem(item.text) === normalizedItem(clean));
    if (same) {
      if (!same.sources.includes(source)) same.sources.push(source);
      if (!same.originals.includes(original ?? text)) same.originals.push(original ?? text);
      return;
    }
    classified.push({ source, sources: [source], originals: [original ?? text], role, text: clean, ...(original && stripEnumerator(original) !== clean ? { original } : {}), scope, ...(step ? { step } : {}), ...(reason ? { reason } : {}) });
  };
  if (rawPlan) for (const key of Object.keys(PLAN_ROLES) as (keyof typeof PLAN_ROLES)[]) {
    let guardedIndex = 0;
    const planContext = [options.taskName ?? "", options.context ?? ""].join("\n");
    for (const item of rawPlan[key] ?? []) {
      const unsupported = hasOnlyUnconfirmedMetrics(item, planContext);
      append(`plan.${key}`, PLAN_ROLES[key], unsupported ? item : guarded?.[key]?.[guardedIndex++] ?? item,
        unsupported ? "근거 없는 성능 수치: 측정 근거와 판정 기준 확인 필요" : undefined, item);
    }
  }
  if (d) {
    for (const [source, role, values] of [
      ["diagnosis.asIs.steps", "reference", d.asIs?.steps ?? []],
      ["diagnosis.asIs.outputs", "outputs", d.asIs?.outputs ?? []],
      ["diagnosis.humanInLoop", "human", d.humanInLoop ?? []],
      ["diagnosis.toBe", "reference", (d.toBe ?? []).map(s => `${s.step} — ${s.description}`)],
      ["diagnosis.poc.inScope", "features", d.poc?.inScope ?? []],
      ["diagnosis.poc.outOfScope", "excluded", d.poc?.outOfScope ?? []],
      ["diagnosis.poc.inputs", "input", d.poc?.inputs ?? []],
      ["diagnosis.poc.outputs", "outputs", d.poc?.outputs ?? []],
      ["diagnosis.poc.evaluation", "tests", d.poc?.evaluation ?? []],
      ["diagnosis.poc.success", "criteria", d.poc?.success ?? []],
      ["diagnosis.poc.failure", "criteria", d.poc?.failure ?? []],
    ] as const) for (const item of values) append(source, role, item);
    for (const step of steps.filter(s => s.scope === "human")) append("policy.manualSteps", "human", step.step);
    // Confirmed checks are reference facts, not open conditions.
    for (const check of d.technicalChecks ?? []) append("diagnosis.technicalChecks", check.status === "확인됨" ? "reference" : "conditions",
      `${check.topic}${check.note ? ` — ${check.note}` : ""}`, check.status === "확인됨" ? "이미 확인된 기술 조건 (참고)" : undefined);
  }
  for (const item of options.prerequisites ?? []) append("options.prerequisites", "conditions", item);
  for (const item of profile?.prerequisites ?? []) {
    // Reuse the technical check's exact evidence instead of creating a second, unlinked condition.
    const existing = classified.find(entry => entry.role === "conditions" && normalizedItem(entry.text) === normalizedItem(item));
    if (existing) {
      if (!existing.sources.includes("policy.prerequisites")) existing.sources.push("policy.prerequisites");
    } else append("policy.prerequisites", "conditions", item);
  }
  // Review-only scope (Level 0 or blocked) is still the permitted scope for its checks, criteria and outputs.
  const permitted = (item: AgentInstructionItem) => item.scope === "implement" || item.scope === "after-check" || item.scope === "verify";
  const scoped = {
    features: classified.filter(item => item.role === "features" && (item.scope === "implement" || item.scope === "after-check")),
    tests: classified.filter(item => item.role === "tests" && permitted(item)),
    criteria: classified.filter(item => item.role === "criteria" && permitted(item) && !VAGUE_CRITERION.test(item.text) && !(VALIDATION_METHOD.test(item.text) && !PASS_CONDITION.test(item.text))),
    validationMethods: classified.filter(item => item.role === "criteria" && permitted(item) && VALIDATION_METHOD.test(item.text) && !PASS_CONDITION.test(item.text)),
    outputs: classified.filter(item => item.role === "outputs" && permitted(item)),
    conditions: classified.filter(item => item.role === "conditions" && permitted(item)),
  };
  const conditions: AgentInstructionModel["conditions"] = {
    current: scoped.conditions,
    future: classified.filter(item => item.role === "conditions" && item.scope === "future"),
    global: classified.filter(item => item.role === "human" || item.role === "security" && item.scope !== "future" && item.scope !== "human"),
    confirm: classified.filter(item => item.role === "conditions" && !permitted(item) && item.scope !== "future"),
  };
  const gaps = !d ? ["진단 결과 없음: Level·실행 상태를 확인하기 전에는 생성 계획의 제안을 확정 구현하지 마세요."] : [
    ...(!profile ? ["Factor·Decision Gate 등 실행 범위의 필수 진단 정보가 누락됨: 확인 전 구현 금지"] : []),
    ...(d.asIs?.inputs?.length ? [] : ["입력 자료와 샘플 형식 (진단에 입력 정보 없음)"]),
    ...(d.asIs?.outputs?.length ? [] : ["결과물 형식과 보고 양식 (진단에 출력 정보 없음)"]),
    ...(steps.length ? [] : ["업무 단계별 진단 정보 없음: 구현할 단계와 담당자 단계를 먼저 확인"]),
  ];
  const methodEvidence = steps.map((s, index) => stepMethod(s,
    steps.some((other, otherIndex) => otherIndex !== index && normalizedStepText(other.step) === normalizedStepText(s.step)), d));
  return { profile, level, gate, scopeLevel, steps, methods: methodEvidence.map(item => item.method), methodReasons: methodEvidence.map(item => item.reason),
    methodChains: methodEvidence.map(item => item.chain), methodOrders: methodEvidence.map(item => item.order), conditions, classified,
    ambiguous: classified.filter(item => item.scope === "confirm" && item.role !== "reference"),
    scoped, diagnosis: d, plan: guarded, prerequisites: options.prerequisites ?? [], gaps };
}

/** One coding-agent instruction for any supported tool; the model is computed once. */
export function buildAllInOnePrompt(rawPlan: AxPlan | undefined, _tool: AxToolId, options: PromptOptions = {}): string {
  const model = buildAgentInstructionModel(rawPlan, options);
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${stripEnumerator(item)}`).join("\n");
  const { profile, level, gate, scopeLevel, steps, gaps } = model;
  const d = model.diagnosis;
  const work = steps.filter(s => s.scope === "implement" || s.scope === "after-check");
  const review = steps.filter(s => s.scope === "verify");
  const future = steps.filter(s => s.scope === "future");
  const human = steps.filter(s => s.scope === "human");
  const humanKept = unique([...human.map(s => `${s.step} (담당자 수행)`), ...model.classified.filter(item => item.role === "human").map(item => item.original ?? item.text)]);
  // "<human step> 자동화" only restates that a human step is kept; the human line above already says so.
  const humanRestatements = new Set(human.flatMap(s => [`${s.step} 자동화`, `${s.step} 자동화 (담당자 수행)`]).map(normalizedItem));
  const excluded = without([...(profile?.poc.outOfScope ?? []), ...model.classified.filter(item => item.role === "excluded").map(item => item.text)], humanKept)
    .filter(item => !humanRestatements.has(normalizedItem(item)));
  const proposal = (item: AgentInstructionItem) => ["goal", "features"].includes(item.role) && item.sources.some(source => source.startsWith("plan."));
  // Proposals linked to a future step are listed beneath that step, not as separate work.
  const relatedFuture = (step: string) => unique(model.classified.filter(item => item.scope === "future" && item.step === step && proposal(item)).map(item => item.text));
  const outside = unique(model.classified.filter(item => item.scope === "future" && proposal(item) && !future.some(s => s.step === item.step)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  const outsideHuman = unique(model.classified.filter(item => item.scope === "human" && proposal(item)).map(item => `생성 계획 제안: ${item.text} — ${item.reason}`));
  // Only generated proposals are labelled as plan proposals; raw diagnosis PoC scope is superseded by the policy scope above.
  const unlinked = unique(model.ambiguous.filter(item => item.role === "features" && proposal(item)).map(item => `${item.text} — ${item.reason}`));
  const goals = model.classified.filter(item => item.role === "goal");
  const evidenceLine = (item: AgentInstructionItem) => `${item.text}${item.step ? ` (관련 단계: ${item.step})` : ""}${item.reason ? ` — ${item.reason}` : ""}${item.originals.some(text => normalizedItem(text) !== normalizedItem(item.text)) ? `; 원문: ${item.originals.join(" / ")}` : ""}`;
  const conditions = model.conditions.current.map(evidenceLine);
  const futureConditions = model.conditions.future.map(evidenceLine);
  const unassignedConditions = model.conditions.confirm.map(evidenceLine);
  const exceptions = unique([...model.classified.filter(item => item.role === "exception").map(item => item.text), ...(d?.asIs?.exceptions ?? []), ...(d?.risks ?? [])]);
  const constraints = approvalConstraints(model);
  const humanConstraints = model.classified.some(item => item.role === "human"
    && item.sources.some(source => source === "diagnosis.humanInLoop" || source === "plan.humanInLoop" || source === "policy.manualSteps"));
  const method = (s: StepScope) => model.methods[steps.indexOf(s)] ?? "confirm";
  const methodLabel = (s: StepScope) => stepMethodLabel(model, steps.indexOf(s));
  const methodOrder = (s: StepScope) => model.methodOrders[steps.indexOf(s)];
  const doneWhen = (s: StepScope) => method(s) === "assist"
    ? "실제 입력으로 후보·초안이 생성되고, 담당자 확정 전에는 운영 결과로 반영되지 않으며, 생성할 수 없는 건은 검토 필요·실패로 표시됩니다."
    : method(s) === "composite" && methodOrder(s) === "parallel"
    ? "병행 처리가 확인되었으나 실행 순서와 의존성이 확정되지 않았습니다. 실제 실행 전 처리 순서를 담당자에게 확인하고, 각 역할의 완료 기준을 모두 만족할 때 완료로 인정합니다. 확인 전에는 순차 실행을 가정하지 마세요."
    : method(s) === "composite"
    ? "확인된 처리 순서대로 각 역할이 실제 입력으로 동작하고, AI 결과는 담당자 확정 전 운영 결과로 반영되지 않으며, 규칙·스크립트는 확인된 기준만 적용되고, 담당자 확인이 유지됩니다. 각 단계의 완료는 해당 역할의 완료 기준을 모두 만족할 때 인정됩니다."
    : method(s) === "rule" || method(s) === "script" ? "확인된 형식·키·업무 규칙으로 실제 입력이 처리되고, 담당자가 확정한 기대 결과와 대조한 기록 및 원본 대응 관계가 남습니다. 기대 결과·판정 기준이 없으면 '기준 확인 필요'로 보고하고 합격으로 단정하지 마세요."
    : method(s) === "manual" ? "담당자가 수행할 작업과 시스템이 보조할 범위를 확인하고, 담당자 수행 결과와 미확인 조건만 기록합니다. 수동 업무를 신규 자동화 기능으로 바꾸지 마세요."
    : "처리 방식이 확정되지 않았습니다. 처리 방식의 근거·충돌 내용·필수 기준을 먼저 확인하고, 미확정 사항과 재개 조건을 보고하세요. 방식이 확정되기 전에는 구현을 시작하지 마세요.";
  const stepLine = (s: StepScope) => `${s.step} — ${methodLabel(s)}${s.note ? ` (진단 메모: ${s.note})` : ""}`;
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
  const a = profile && d ? axes(d) : undefined;
  section("작업 목표·실행 범위",
    d && level && gate && a ? `### 진단 기준\n\n${bullets([
      ...(d.asIs?.purpose ? [`업무 목적: ${d.asIs.purpose}`] : []),
      `자동화 수준: ${level.label.replace(/^L\d+ /u, "")} · Level ${level.level}${level.provisional ? " (정보 부족으로 잠정 판정)" : ""}`,
      `자동화 가치: ${a.value}/5`, `기술 실현 가능성: ${a.feasibility}/5`, `담당자 판단 필요도: ${a.judgment}/5`, `운영 위험: ${a.risk}/5`,
      `실행 상태: ${GATE_LABELS[gate]}`,
    ])}\n\n${LEVEL_CONSTRAINTS[level.level]} 실제 실행 범위는 Level 정책과 실행 상태가 함께 허용한 범위이며, TO-BE·생성 계획·매트릭스 위치는 이 범위를 넓히지 않습니다.` : "",
    `### 이번 작업 목표\n\n${objective}`,
    ...scopeGroups,
    profile?.scopeSupport.length ? `### 함께 수행할 확인\n\n${bullets(profile.scopeSupport)}` : "",
    humanKept.length ? `### 담당자 수행 유지 (자동화로 대체하지 않음)\n\n${bullets(humanKept)}` : "",
    excluded.length || outsideHuman.length ? `### 현재 자동화 제외\n\n${bullets([...excluded, ...outsideHuman])}` : "",
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
    gate ? `실행 상태는 \`${GATE_LABELS[gate]}\`입니다. ${gate === "conditional" && scopeLevel === 0
      ? "Level 0 범위는 검토·검증만 허용합니다. 각 검토 작업이 의존하는 항목이 확인되지 않았으면 그 검토만 보류하고 '확인·승인 대기'로 보고하세요. 의존하지 않는 검토(프로젝트 구조·기존 자료 확인 등)는 진행할 수 있습니다."
      : GATE_CONSTRAINTS[gate]}` : "",
    gate === "blocked" && profile?.blockReasons.length ? `### 차단 사유\n\n${bullets(profile.blockReasons)}` : "",
    conditions.length ? `### 현재 필수 조건\n\n${bullets(conditions)}` : "",
    unassignedConditions.length || gaps.length ? `### 적용 단계 확인 필요\n\n${bullets([...unassignedConditions, ...gaps])}` : "",
    humanConstraints ? HUMAN_DECISION_CHECK : "",
    constraints.length ? `### 기존 담당자·제외 제약\n\n${bullets(constraints)}` : "",
    unassignedConditions.length ? "미연결 조건의 적용 대상과 의존 관계를 실제 자료로 확인하세요. 무관하다고 임의로 해제하지 말고, 영향 가능성이 있는 작업은 확인·승인 대기로 두세요. 해당 조건과 독립적이라는 근거가 확인된 허용 작업만 계속 진행할 수 있습니다. 전역 안전·승인 제약과 전체 Gate 차단은 그대로 적용됩니다." : "",
    "확인되지 않은 API·권한·파일 형식·연동 방식·계산식·반올림·중복 기준·승인 주체를 가정해 구현하지 마세요.",
  );
  const inputs = d ? unique([...(d.asIs?.inputs ?? []), ...without(d.poc?.inputs ?? [], d.asIs?.inputs ?? []).map(item => `검증용: ${item}`)]) : [];
  const outputs = model.classified.filter(item => item.role === "outputs");
  // Generated AS-IS/TO-BE restatements of diagnosed steps are shown once, in the diagnosis flow above.
  const diagnosedFlow = new Set([...(d?.asIs?.steps ?? []), ...(d?.toBe ?? []).flatMap(s => [s.step, s.description, `${s.step} — ${s.description}`])].map(normalizedItem));
  const planReferences = unique(model.classified.filter(item => item.role === "reference" && ["plan.asIs", "plan.toBe", "plan.poc"].includes(item.source) && !diagnosedFlow.has(normalizedItem(item.text)))
    .map(item => `${item.source}: ${item.text}`));
  section("업무 데이터 흐름",
    inputs.length || d?.asIs?.trigger || d?.asIs?.systems?.length ? `### 입력\n\n${bullets([
      ...inputs, ...(d?.asIs?.trigger ? [`업무 발생 주기·시점: ${d.asIs.trigger} (자동 실행 요구사항 아님)`] : []), ...(d?.asIs?.systems?.length ? [`사용 시스템: ${d.asIs.systems.join(", ")}`] : []),
    ])}\n\n실제 샘플의 형식과 필수 항목을 확인한 뒤 처리하고, 확인 전에는 항목명·경로를 하드코딩하지 마세요.` : "",
    d?.asIs?.steps?.length ? `### 현재 업무 흐름 (AS-IS)\n\n${numbered(d.asIs.steps)}` : "",
    `### 현재 출력\n\n${model.scoped.outputs.length ? `${bullets(model.scoped.outputs.map(item => `${evidenceLine(item)} — ${item.scope === "after-check" ? "관련 조건 충족 후 생성 가능한 조건부 출력" : item.scope === "verify" ? "기존 자료를 이용한 검토·검증 결과; 신규 생성 기능 금지" : "허용된 단계의 출력"}`))}\n\n` : "연결된 현재 출력 없음: 생성 단계와 형식을 확인하기 전 필수 출력으로 확정하지 마세요.\n\n"}결과는 정상·검토 필요·확인 불가·처리 실패로 구분하고, 실패·확인 불가 건을 정상 결과에 섞지 마세요.`,
    "### 계산·판정 기준\n\n업무에 계산·판정이 있으면 확인된 계산식·입력·순서·반올림·누락 처리 기준만 사용하세요. 정의되지 않은 기준은 구현하지 말고 '확인 필요'로 보고하세요.",
    "### 추적\n\n원본 추적이 필요한 업무라면 결과에서 원본 출처·처리 단계·오류 위치·담당자 확인 결과를 확인할 수 있게 유지하세요. 업무와 관계없는 식별 정보(예: 시트·행 번호)를 강제하지 마세요.",
    `### 실행 방식\n\n${scopeLevel === 1 ? "담당자 요청 기반 실행만 허용합니다. 스케줄러·폴더 감시 등 정기 무인 실행을 구현하지 마세요." : scopeLevel === 0 ? "검토·검증만 허용하며 업무 자동 실행을 추가하지 마세요." : "업무 발생 주기와 시스템 자동 실행은 별개입니다. 실제 자동 실행 요청·근거·정책 허용 여부가 확인되지 않았다면 실행 방식 확인 필요로 보고하세요."}`,
  );
  const linkedTo = (step: string) => model.scoped.features.filter(item => item.step === step && item.sources.some(source => source.startsWith("plan."))).map(item => item.text);
  const currentOutputs = unique(model.scoped.outputs.map(item => item.text));
  const minimalFlow = work.length ? numbered([
    `입력: ${d?.asIs?.inputs?.length ? d.asIs.inputs.join(", ") : "입력 자료 확인 필요"} — 실제 샘플로 형식과 필수 항목을 확인${scopeLevel === 1 ? "하고 담당자가 실행을 요청" : ""}`,
    ...work.map(s => `${s.step}: ${methodLabel(s)}`),
    "결과 구분: 정상·검토 필요·확인 불가·처리 실패를 분리하고 원본 출처를 유지",
    `담당자 확인: ${human.length ? human.map(s => s.step).join(", ") : "담당자 확인 지점"} — 승인 전 확정·전송 금지`,
    `출력: ${currentOutputs.length ? currentOutputs.join(", ") : "구현 단계와 연결된 출력 형식 확인 필요 (진단 출력은 '업무 데이터 흐름' 참고)"}`,
    "실행 방법: 저장소에서 확인한 실제 실행 명령·화면으로 위 흐름을 재현할 수 있게 제공",
  ]) : "";
  section("단계별 실제 구현",
    work.length ? `### 최소 실행 흐름\n\n${minimalFlow}\n\n구현은 위 흐름에서 이 업무에 해당하는 단계만 의존 순서대로 연결하세요.\n\n${work.map((s, i) => `### 단계 ${i + 1}. ${s.step} — ${methodLabel(s)}\n\n${bullets([
      `처리 상태: ${s.scope === "implement" ? SCOPE_TITLES.implement : `${SCOPE_TITLES["after-check"]} (관련 확인 항목이 확인되기 전에는 보류)`}`,
      ...(s.note ? [`진단 메모: ${s.note}`] : []),
      `담당자 확인: ${method(s) === "assist" ? "AI 결과는 제안값으로 표시하고 담당자가 확정한 값과 구분하세요. 규칙으로 판정할 부분에 별도 AI 호출을 추가하지 마세요." : method(s) === "composite" && methodOrder(s) === "parallel" ? "병행 처리 관계가 확인되었으므로 순차 실행을 가정하지 말고, 실제 실행 순서와 의존성을 담당자에게 먼저 확인하세요. 각 역할을 담당자 확인·승인 단계로 승격하거나 무인 실행으로 바꾸지 마세요." : method(s) === "composite" ? "확인된 복합 처리 순서를 유지하고, 각 역할을 담당자 확인·승인 단계로 승격하거나 무인 실행으로 바꾸지 마세요. AI 결과는 제안값으로, 규칙·스크립트는 확인된 기준으로, 최종 확인은 담당자가 수행합니다." : method(s) === "rule" || method(s) === "script" ? "파일 형식·병합 키·계산식·예외 규칙 등 이 단계에 필요한 실제 기준을 확인한 뒤 적용하세요. 규칙 미확인 건은 담당자 확인으로 넘기고 AI 호출을 추가하지 마세요." : method(s) === "manual" ? "담당자 수동 수행을 유지하고 자동화 구현으로 대체하지 마세요." : "AI·규칙·스크립트·수동 처리의 근거와 충돌을 담당자에게 확인하기 전에는 선택·구현하지 마세요."}`,
      ...linkedTo(s.step).map(item => `세부 제안 (생성 계획): ${item}`),
      `완료 기준: ${doneWhen(s)}`,
    ])}`).join("\n\n")}` : "",
    review.length ? `### 검토·검증 작업\n\n${bullets([...review.map(s => `${s.step} ${methodLabel(s)}`), ...(profile?.scopeSupport ?? [])])}\n\n샘플과 업무 규칙으로 확인한 결과를 보고하는 범위입니다. ${gate === "blocked" ? "운영 기능·자동 실행 코드·스캐폴딩을" : "운영 기능이나 자동 실행 코드를"} 만들지 마세요.` : "",
    unlinked.length ? `### 범위 확인이 필요한 생성 계획 제안\n\n${bullets(unlinked)}\n\n위 제안은 '작업 목표·실행 범위'의 어느 단계에 속하는지 확인되기 전에는 구현하지 마세요.` : "",
    work.length ? "### 실제 동작하는 기본 토대\n\n필요한 자료와 확인이 갖춰진 단계는 실제 입력을 받고, 정의된 처리를 실행하고, 잘못된 입력과 실패를 정상 결과와 구분하고, 필요한 담당자 확인을 유지하고, 실행·검증 방법을 제공해야 완료입니다.\n\n처리 없는 화면, 읽지 못하는 업로드, 더미 데이터 결과, 가짜 API 응답, TODO만 있는 핵심 함수, 실행되지 않는 샘플 코드, 검증하지 않은 계산, 미확인 규칙을 가정한 구현, 승인 없이 확정되는 AI 결과는 완료가 아닙니다.\n\n필수 자료가 없으면 전체 흐름을 억지로 완성하지 말고 허용된 독립 단계만 완성하세요. 허용된 독립 단계가 없으면 코드를 만들지 말고 필요한 선행 확인사항을 보고하세요." : "",
    "기존 구현을 우선 재사용하고 요청 범위 안에서 최소한으로 수정하세요. 요청하지 않은 기능·라이브러리, 하드코딩 값, 실제 로직에 남은 테스트용 임시 데이터, 근거 없는 수치 목표, 확인되지 않은 담당 조직·승인 주체를 만들지 마세요.",
  );
  const fallback = unique([...(d?.operation?.fallback ? [d.operation.fallback] : []), ...model.classified.filter(item => (item.role === "fallback" || item.role === "operation") && ["implement", "after-check", "verify"].includes(item.scope)).map(item => item.text)]);
  section("예외·보안·승인",
    exceptions.length ? `### 예외\n\n${bullets(exceptions)}` : "",
    "실패·미매칭·확인 불가 데이터는 정상 결과와 분리해 원인과 대상을 확인할 수 있게 하세요. 자동 삭제·자동 보정은 업무 규칙에 명시된 경우에만 적용하고, 아니면 대상 건을 표시만 하세요.",
    work.length ? "### 반복 실행\n\n같은 입력 재처리, 같은 이름의 다른 파일, 일부 성공 후 실패, 처리 중단·재시도, 이전 요청의 뒤늦은 완료, 입력 변경 후 기존 결과 재사용 중 이 업무에 해당하는 경우를 확인하세요. 기존 처리 정책을 먼저 따르고, 중복 반영·기존 데이터 삭제·미검증 데이터의 정상 집계가 없게 하되 필요 없는 작업 큐·트랜잭션 구조는 추가하지 마세요." : "",
    `### 담당자 확인·승인\n\n${constraints.length ? "'선행 조건·차단 사항'의 기존 담당자·제외 제약을 그대로 지키세요. " : ""}담당자 판단·확정이 필요한 결과는 확인되지 않은 승인으로 확정·시스템 반영·외부 전송하거나 담당자 판단을 대체하지 마세요. 허용된 후보·초안·규칙 검토는 각 단계의 선행 조건 내에서 진행할 수 있습니다. 승인 주체·권한이 확인되지 않았으면 지정하지 마세요.`,
    `### 보안\n\n${bullets([
      ...model.conditions.global.filter(item => item.role === "security").map(evidenceLine),
      "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
      "기존 인증·권한 구조와 최소 권한 원칙을 유지하고, 민감한 데이터를 불필요하게 로그에 남기지 마세요.",
      "외부 AI 서비스로 업무 자료를 보내기 전에 보안 조건을 확인하고, 확인되지 않은 연동은 자동 실행하지 마세요.",
      "보안 제약은 관련 작업에 적용하되 현재 수행하지 않는 저장·전송·운영 기능의 보안 구현을 새로 개발하지 마세요. 미연결 보안 항목은 영향 범위를 확인하고 안전하다고 임의로 해제하지 마세요.",
    ])}`,
    `### 수동 전환\n\n${fallback.length ? `${bullets(fallback)}\n\n` : ""}자동화가 실패해도 기존 수동 업무를 계속할 수 있게 유지하세요. 실제 수동 절차와 운영 담당이 확인되지 않았으면 새로 정하지 마세요.`,
  );
  const tests = unique(model.scoped.tests.map(item => item.text));
  section("테스트·회귀 검증",
    "저장소에 실제로 존재하는 검증 명령과 도구를 확인한 뒤 실행하세요. 없는 테스트 framework나 명령을 임의로 설치하지 마세요.",
    work.length ? `### 정상 케이스\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}기대 결과가 확정된 샘플로 결과를 대조하세요. 기대 결과·허용 오차가 정의되지 않았으면 합격 기준을 만들지 말고 '확인 필요'로 보고하세요.`
      : `### 현재 검토·검증\n\n${tests.length ? `${bullets(tests)}\n\n` : ""}확보한 샘플과 기존 자료로 확인할 수 있는 범위만 검증하세요. 검증을 위해 새 기능·자동 생성 코드를 만들지 말고, 비교 자료가 없으면 '검증 불가'와 사유를 기록하세요. 수행하지 않은 검증을 성공·실패로 판정하지 마세요.`,
    model.scoped.validationMethods.length ? `### 검증 방법·기록 (합격 조건 아님)\n\n${bullets(model.scoped.validationMethods.map(evidenceLine))}` : "",
    work.length ? "### 경계값\n\n입력 1건, 빈 입력, 같은 기준값이 여러 건인 경우, 선택 항목이 비어 있는 경우처럼 이 업무의 입력에 해당하는 경계 상황을 확인하세요." : "",
    work.length ? "### 실패·예외 케이스\n\n현재 구현 단계와 연결되고 실제로 재현 가능한 입력·처리 예외만 검증하세요. 인적 판단 오류·외부 장애 등 재현 근거가 없는 위험은 검토 항목으로 기록하세요. 모든 업무 예외를 E2E로 구현하지 마세요. 해당 단계의 잘못된 형식·필수 항목 누락 같은 실패가 정상 결과로 표시되지 않는지 확인하세요." : "",
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
    ...(gate === "blocked" || !profile ? ["실행 범위가 차단·미확정 상태에서는 배포·운영 적용·연결을 수행하지 마세요. 차단 해제에 필요한 조건만 보고하세요."] : []),
  ]));
  const criteria = unique(model.scoped.criteria.map(evidenceLine));
  const deferredCriteria = model.classified.filter(item => item.role === "criteria" && !model.scoped.criteria.includes(item) && !model.scoped.validationMethods.includes(item))
    .map(item => `${evidenceLine(item)} — ${VAGUE_CRITERION.test(item.text) ? "기대 결과·측정 기준 확인 필요" : "현재 필수 완료 조건 아님"}`);
  section("완료 조건",
    work.length ? `### 단계별\n\n${bullets(work.map(s => s.scope === "implement" ? `${s.step}: ${doneWhen(s)}` : `${s.step}: 확인 항목이 확인되어 구현했다면 ${doneWhen(s)} 확인하지 못했다면 '확인·승인 대기'로 보고합니다.`))}` : "",
    review.length ? `### 검토·검증\n\n${bullets([
      "확인한 프로젝트 구조와 재사용 가능한 기존 구현이 정리됩니다.",
      ...(d?.asIs?.inputs?.length || d?.poc?.inputs?.length ? ["확보한 샘플의 데이터 형식과 필수·누락 항목이 기록됩니다."] : []),
      ...(d?.asIs?.humanDecisions?.length || d?.asIs?.exceptions?.length ? ["업무 규칙·예외 기준의 확인 결과가 정리됩니다."] : []),
      ...review.map(s => `${s.step}: 처리 가능성과 기술적 제약이 근거 자료와 함께 정리됩니다.`),
      ...(conditions.length || futureConditions.length ? ["추가로 확보할 자료와 미확인 조건이 정리됩니다."] : []),
      "다음 진단에 필요한 정보가 보고됩니다.",
    ])}` : "",
    criteria.length ? `### 판정 기준\n\n${bullets(criteria)}` : "",
    `### 공통\n\n${bullets([
      "기존 기능과 데이터가 유지됩니다.",
      ...(humanKept.length ? ["담당자 검토·승인 단계가 유지됩니다."] : []),
      "'향후 확장'·'제외' 항목이 구현되거나 실행되지 않습니다.",
      ...(gate === "blocked" || !profile ? ["운영 구현과 실행은 차단되고 검토·검증 결과와 차단 해제 조건만 기록됩니다."] : work.length ? ["정상·경계·실패 케이스 검증이 통과하고, 실패 건이 정상 결과와 구분됩니다."] : ["운영 기능·자동 실행 코드 없이 검토·검증 결과가 근거와 함께 보고됩니다."]),
      work.length ? "타입 오류와 빌드 오류가 없습니다." : "코드를 변경했다면 타입 오류와 빌드 오류가 없습니다.",
      "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
    ])}`,
    `### 완료 상태 구분\n\n${bullets(work.length ? [
      "구현·검증 완료: 실제 구현 후 검증 통과", "구현 완료·검증 미완료: 구현했지만 정상 동작 확인 부족", "부분 구현: 허용된 일부 기능만 구현",
      "확인·승인 대기: 필수 정보 또는 승인 부족", "정책상 제외·차단: 현재 실행 대상 아님", "구현 실패: 구현 또는 검증 실패",
    ] : [
      "검토 완료: 확인한 자료로 검토를 마침", "검증 완료: 실제 자료로 검증을 마침", "일부 확인: 일부 자료만 확인", "확인 필요: 근거 자료 부족",
      "확인·승인 대기: 필수 정보 또는 승인 부족", "정책상 제외·차단: 현재 실행 대상 아님", "검증 실패: 검증했지만 기준 미충족", "미실행: 수행하지 않음",
    ])}\n\n${work.length ? "스캐폴딩·TODO·모의 구현만 있는 기능은 완료로 보고하지 마세요." : "수행하지 않은 검토·검증을 완료로 보고하지 마세요."}`,
  );
  section("인수인계·완료 보고", "작업이 끝나면 다음 형식으로 보고하세요.", numbered([
    "확인한 프로젝트 구조", "현재 Level·실행 상태와 허용 범위", "단계별 완료 상태 (위 완료 상태 구분 사용)", "수정·생성한 파일", "입력·처리·출력 구조",
    "실제로 확인한 실행 방법과 명령", "검증 결과 (실행하지 않은 검증은 미실행)", "담당자 확인이 필요한 항목", "미구현·보류·차단된 기능과 해결 조건",
    "다음 개발 단계", "Git 상태", "배포·운영 적용 상태",
  ]), "확인하지 않은 환경변수·API·파일 경로를 적지 말고, 계획이나 미구현 기능을 실행 가능한 코드와 구분하세요. 실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.");
  section("향후 계획·연결 확인 참고",
    "아래는 현재 필수 구현·출력·테스트·완료 조건이 아닙니다. 해당 단계의 Level·Gate와 의존 조건을 다시 확인하기 전 구현 범위를 확장하지 마세요.",
    future.length || outside.length ? `### 향후 확장 (이번 작업에서 구현하지 않음)\n\n${bullets([
      ...future.map(s => `${s.step} — 현재 Level ${scopeLevel} 범위 밖 (진단 메모: ${s.note || "없음"})${relatedFuture(s.step).length ? `; 관련 생성 계획: ${relatedFuture(s.step).join(", ")}` : ""}`),
      ...outside,
    ])}` : "",
    goals.some(item => item.scope !== "future") ? `### 생성 계획 목표 (참고)\n\n${bullets(goals.filter(item => item.scope !== "future").map(evidenceLine))}` : "",
    futureConditions.length ? `### 향후 단계 확인 조건 (현재 작업의 선행 조건 아님)\n\n${bullets(futureConditions)}` : "",
    d?.toBe?.length ? `### 목표 업무 흐름 (TO-BE, 참고)\n\n${numbered(d.toBe.map(s => `${s.step} — ${OWNER_LABELS[s.owner]}: ${s.description}`))}` : "",
    model.classified.some(item => item.role === "flow") ? `### 처리 흐름 (생성 계획·참고)\n\n${bullets(model.classified.filter(item => item.role === "flow").map(evidenceLine))}` : "",
    planReferences.length ? `### 생성 계획의 AS-IS·TO-BE·PoC (참고)\n\n${bullets(planReferences)}` : "",
    outputs.some(item => !model.scoped.outputs.includes(item)) ? `### 향후·참고·연결 확인 출력\n\n${bullets(outputs.filter(item => !model.scoped.outputs.includes(item)).map(item => `${evidenceLine(item)} — ${item.sources.includes("diagnosis.asIs.outputs") ? "기존 업무의 전체 출력·참고" : item.scope === "future" ? "향후 출력" : "생성 단계 연결 확인 필요"}`))}` : "",
    model.classified.some(item => item.role === "tests" && !model.scoped.tests.includes(item)) ? `### 향후·범위 확인 테스트 (이번 구현의 필수 검증 아님)\n\n${bullets(model.classified.filter(item => item.role === "tests" && !model.scoped.tests.includes(item)).map(evidenceLine))}` : "",
    deferredCriteria.length ? `### 향후·기준 확인이 필요한 판정 (이번 구현의 필수 완료 조건 아님)\n\n${bullets(deferredCriteria)}` : "",
    model.classified.some(item => item.role === "security" && !model.conditions.global.includes(item) || (item.role === "operation" || item.role === "fallback") && !["implement", "after-check", "verify"].includes(item.scope)) ? `### 향후·범위 확인 운영·보안 제안\n\n${bullets(model.classified.filter(item => item.role === "security" && !model.conditions.global.includes(item) || (item.role === "operation" || item.role === "fallback") && !["implement", "after-check", "verify"].includes(item.scope)).map(evidenceLine))}` : "",
  );
  return [
    axPromptTitle(options.taskName),
    "WorkLens 업무 자동화 진단 결과로 만든 실행 지시문입니다. Codex·Claude Code·OMP 등 어떤 코딩 에이전트에서도 같은 실행 범위와 완료 기준을 따르세요. 대상 저장소를 먼저 확인한 뒤 '작업 목표·실행 범위' 안에서만 구현하세요.",
    ...sections.filter(s => s.body).map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.body}`),
  ].join("\n\n");
}
