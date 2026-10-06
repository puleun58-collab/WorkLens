import type { AxDiagnosis, AxPlan } from "./types";
import { automationLevel, axes, executionGate, GATE_LABELS } from "./policy";

export type AxToolId = "codex" | "claude";

export const TOOL_GUIDES: Record<AxToolId, {
  name: string; versionCommand: string; installCommand: string; runCommand: string; doctorCommand: string; loginNote: string;
}> = {
  codex: { name: "Codex", versionCommand: "codex --version", installCommand: "npm install -g @openai/codex@latest", runCommand: "codex", doctorCommand: "codex doctor", loginNote: "첫 실행 시 ChatGPT 계정으로 로그인합니다." },
  claude: { name: "Claude Code", versionCommand: "claude --version", installCommand: "npm install -g @anthropic-ai/claude-code", runCommand: "claude", doctorCommand: "claude doctor", loginNote: "첫 실행 시 브라우저에서 로그인합니다." },
};

/** Inline text marks commands with backticks; `code` blocks default to PowerShell unless labeled as examples. */
export type AxGuideBlock = { kind: "text"; text: string } | { kind: "code"; lines: string[]; notes?: string[]; label?: "PowerShell" | ".gitignore" | "예시" } | { kind: "steps"; items: string[] };
export interface AxGuideSection { title: string; when?: string; blocks: AxGuideBlock[] }
export interface AxGuideStep { title: string; sections: AxGuideSection[] }

const text = (value: string): AxGuideBlock => ({ kind: "text", text: value });
const code = (lines: string[], notes: string[], label?: Extract<AxGuideBlock, { kind: "code" }>["label"]): AxGuideBlock => ({ kind: "code", lines, notes, ...(label ? { label } : {}) });

export function setupGuide(tool: AxToolId): AxGuideStep[] {
  const guide = TOOL_GUIDES[tool];
  return [
    { title: "시작하기 전에 · 전체 흐름", sections: [
      { title: "한눈에 보기", blocks: [{ kind: "steps", items: [
        "처음 준비", "프로젝트 열기", "Codex/Claude Code 실행", "올인원 지시문", "작업 결과 확인",
        ".gitignore/Secret 확인", "Git 저장", "CI/PR 확인", "Vercel 또는 Cloudflare 배포", "Production 확인",
      ] }] },
      { title: "처음 한 번만 준비 / 작업할 때마다", blocks: [
        text("Git·GitHub 인증·AI 도구 설치는 STEP 1에서 처음 한 번만 준비합니다. 설치는 처음 한 번만, 매번 반복하지 않습니다. 작업할 때마다 STEP 2부터 진행합니다."),
        text("Codex와 Claude Code 중 하나만 사용하면 됩니다. 두 개 다 설치할 필요는 없습니다."),
      ] },
      { title: "자주 나오는 용어", blocks: [{ kind: "steps", items: [
        "저장소(Repository): 프로젝트 파일과 변경 기록을 모아 둔 곳입니다.",
        "브랜치(Branch): 다른 작업과 나누어 변경을 진행하는 작업 갈래입니다.",
        "커밋(Commit): 변경 내용을 설명과 함께 Git에 기록하는 단위입니다.",
        "푸시(Push): PC의 커밋을 GitHub 같은 원격 저장소에 올리는 작업입니다.",
        "CI: 코드를 올렸을 때 테스트·빌드 등을 자동으로 확인하는 과정입니다.",
        "Preview: 실제 서비스 반영 전에 확인하는 배포 환경입니다.",
        "Production: 사용자가 실제로 이용하는 서비스 환경입니다.",
        "환경변수(Environment Variable): 코드 밖에서 설정하는 변수로 서비스 주소나 인증 값 등을 담습니다.",
        "Secret: API Key나 비밀번호처럼 공개하면 안 되는 인증 정보입니다.",
        ".gitignore: Git에 새로 포함하지 않을 파일·폴더 규칙을 적는 파일입니다.",
      ] }] },
    ] },
    { title: "STEP 1 · 처음 한 번 환경 준비", sections: [
      { title: "필요한 프로그램 확인", blocks: [
        text("PowerShell을 열고 먼저 설치 여부를 확인합니다. 버전이 표시되는 프로그램은 이미 설치된 것이므로 해당 설치 단계를 건너뜁니다."),
        text("Node.js는 프로젝트가 필요로 할 때만 준비합니다."),
        code(["git --version", "node --version", "npm --version", guide.versionCommand], [
          "Git 설치 여부와 버전을 확인합니다.",
          "Node.js 설치 여부와 버전을 확인합니다.",
          "npm 설치 여부와 버전을 확인합니다.",
          `${guide.name} 설치 여부와 버전을 확인합니다.`,
        ]),
      ] },
      { title: "Git 설치", when: "Git 버전이 표시되지 않는 경우에만", blocks: [
        code(["winget install --id Git.Git -e --source winget"], ["Windows 패키지 관리자로 Git을 설치합니다."]),
        text("설치 후 새 PowerShell을 열고 `git --version`으로 다시 확인합니다."),
      ] },
      { title: "Node.js 설치", when: "프로젝트에 Node.js가 필요하고 버전이 표시되지 않는 경우에만", blocks: [
        text("nodejs.org에서 LTS를 설치하고 `node --version`으로 다시 확인합니다. 프로젝트에 .nvmrc, .node-version 또는 package.json engines가 있으면 해당 요구사항을 우선합니다."),
      ] },
      { title: "Git 사용자 정보", when: "처음 한 번, 값이 비어 있을 때만", blocks: [
        text("현재 값을 확인합니다."),
        code(["git config --global user.name", "git config --global user.email"], [
          "커밋에 기록할 사용자 이름이 설정되어 있는지 확인합니다.",
          "커밋에 기록할 이메일이 설정되어 있는지 확인합니다.",
        ]),
        text("비어 있을 때만 설정합니다. 기존 값은 덮어쓰지 않습니다."),
        code(['git config --global user.name "이름"', 'git config --global user.email "메일주소"'], [
          "이름을 본인 이름으로 바꾸어 설정합니다.",
          "메일주소를 본인 이메일로 바꾸어 설정합니다.",
        ]),
      ] },
      { title: `${guide.name} 설치`, when: `\`${guide.versionCommand}\`이 실패하는 경우에만`, blocks: [
        code([guide.installCommand], [`${guide.name}를 설치합니다.`]),
        text(`설치 후 \`${guide.versionCommand}\`으로 다시 확인합니다. 문제가 있으면 \`${guide.doctorCommand}\`으로 점검합니다.`),
      ] },
      { title: "GitHub 인증 확인", when: "GitHub CLI(gh)가 설치된 경우에만", blocks: [
        code(["gh auth status"], ["GitHub CLI의 로그인 상태를 확인합니다."]),
        text("로그인되어 있지 않으면 `gh auth login`의 안내를 따릅니다. gh가 없으면 GitHub 웹사이트 로그인·토큰 등 프로젝트의 기존 인증 방식을 그대로 사용합니다. 인증 방식을 추측해 바꾸지 않습니다."),
      ] },
    ] },
    { title: "STEP 2 · 프로젝트 준비", sections: [
      { title: "기본 명령", blocks: [text("`mkdir` 새 폴더 만들기 · `cd` 폴더 이동 · `dir` 폴더 내용 확인 · `Get-Location` 현재 위치 확인")] },
      { title: "A. GitHub에 있는 기존 프로젝트", when: "GitHub에는 프로젝트가 있지만 이 PC에는 아직 없는 경우", blocks: [
        code(["mkdir C:\\Work", "cd C:\\Work", "git clone <저장소 URL>", "cd <프로젝트 폴더>", "git status"], [
          "작업용 폴더를 만듭니다. 이미 있으면 건너뜁니다.",
          "작업용 폴더로 이동합니다.",
          "<저장소 URL>을 실제 URL로 바꾸어 프로젝트를 내려받습니다.",
          "<프로젝트 폴더>를 내려받은 폴더 이름으로 바꾸어 이동합니다.",
          "현재 브랜치와 변경된 파일을 확인합니다.",
        ]),
      ] },
      { title: "B. PC에 이미 있는 프로젝트", when: "이 PC에 기존 프로젝트 폴더가 있는 경우", blocks: [
        code(['cd "C:\\프로젝트\\경로"', "git status", "git branch --show-current", "git remote -v"], [
          "실제 프로젝트 경로로 바꾸어 이동합니다.",
          "현재 브랜치와 미커밋 변경을 먼저 확인합니다.",
          "현재 작업 중인 브랜치 이름을 확인합니다.",
          "연결된 원격 URL이 작업할 GitHub 저장소인지 확인합니다.",
        ]),
        text("이미 Git 저장소면 그대로 사용합니다. 미커밋 변경이 있으면 `git pull`을 실행하지 말고 AI 도구에 현재 상태를 먼저 확인시킵니다."),
      ] },
      { title: "C. 새 프로젝트", when: "새 폴더에서 처음 시작하는 경우", blocks: [
        code(["mkdir C:\\Work\\MyProject", "cd C:\\Work\\MyProject"], [
          "새 프로젝트 폴더를 만듭니다. 경로와 이름은 원하는 값으로 바꿉니다.",
          "방금 만든 프로젝트 폴더로 이동합니다.",
        ]),
        text("이후 AI 도구가 요구사항을 확인해 프레임워크, Git 초기화와 GitHub 연결 필요성을 결정합니다. 특정 프레임워크를 임의로 정하지 않습니다."),
        text("작업 후 Git 저장 전에 현재 폴더가 Git 저장소인지, 원격이 연결됐는지, 맞는 GitHub 저장소인지 확인합니다."),
        code(["git status", "git remote -v"], [
          "현재 폴더가 Git 저장소인지와 변경 상태를 확인합니다.",
          "원격 연결 여부와 대상 GitHub 저장소 URL을 확인합니다.",
        ]),
        text("Git 저장소가 아닌 경우에만 초기화할 수 있습니다. 기존 저장소를 재초기화하거나 기존 remote를 덮어쓰지 않고, branch 이름을 main으로 강제하지 않습니다."),
        text("remote가 없으면 GitHub CLI 또는 웹 등 현재 방식대로 GitHub 저장소를 만들고 연결합니다. 첫 push 전에 `git remote -v`로 대상을 다시 확인합니다."),
      ] },
      { title: "의존성 준비", blocks: [
        { kind: "steps", items: [
          "저장소 지침(AGENTS.md·README·packageManager 필드)을 먼저 확인합니다.",
          "package.json이 있으면 scripts와 의존성을 확인합니다.",
          "lockfile 단서를 확인합니다: package-lock.json → npm, pnpm-lock.yaml → pnpm, yarn.lock → Yarn, bun.lock/bun.lockb → Bun일 가능성이 있습니다.",
          "확인한 저장소의 기존 방식대로 의존성을 설치합니다. 설치 명령은 지침과 실제 설정을 따릅니다.",
        ] },
        text("lockfile 단서 하나로 package manager를 바꾸지 않습니다. 기존 lockfile과 package manager를 우선하며, 설치 과정에서 다른 매니저의 lockfile을 새로 만들거나 기존 lockfile을 교체하지 않습니다. migration은 별도 작업입니다."),
      ] },
      { title: "현재 위치 확인", blocks: [
        code(["Get-Location", "git status"], [
          "현재 PowerShell이 열려 있는 폴더를 확인합니다.",
          "Git 저장소의 브랜치와 변경 상태를 확인합니다.",
        ]),
        text("명령은 실제 프로젝트 폴더에서 실행합니다. 새 프로젝트에 Git 저장소가 아직 없으면 AI 도구와 초기화 필요성을 확인합니다."),
      ] },
    ] },
    { title: "STEP 3 · Codex / Claude Code 실행", sections: [
      { title: "프로젝트 폴더에서 실행", blocks: [
        text("AI 도구는 반드시 작업할 프로젝트 폴더 안에서 실행합니다. `Get-Location`과 `dir`로 위치와 내용을 확인한 뒤 실행하세요."),
        code(['cd "프로젝트 경로"', "Get-Location", "dir", guide.runCommand], [
          "실제 프로젝트 경로로 바꾸어 이동합니다.",
          "현재 위치가 프로젝트 폴더인지 확인합니다.",
          "프로젝트 폴더의 파일과 하위 폴더를 확인합니다.",
          `${guide.name}를 현재 프로젝트에서 실행합니다.`,
        ]),
        text(guide.loginNote),
      ] },
      { title: "작업 시작 전 AI가 먼저 확인할 것", blocks: [{ kind: "steps", items: [
        "저장소 구조를 확인합니다.",
        "AGENTS.md 같은 프로젝트 지침 파일이 있으면 우선 확인합니다. 없으면 새로 만들라고 강제하지 않습니다.",
        "기존 구현·테스트를 확인한 뒤 작업을 시작합니다.",
      ] }] },
    ] },
    { title: "STEP 4 · 올인원 지시문으로 작업", sections: [
      { title: "올인원 지시문 실행", blocks: [
        text("아래 올인원 지시문 영역에서 복사합니다."),
        { kind: "steps", items: [
          `WorkLens에서 ${guide.name}용 올인원 지시문 전체를 복사합니다.`,
          "실행한 AI 도구에 지시문을 붙여넣습니다.",
          "AI가 저장소를 분석하고 구현·검증을 진행합니다. 승인·검토 요청이 있으면 내용을 확인합니다.",
        ] },
      ] },
    ] },
    { title: "STEP 5 · AI 작업 결과 검증", sections: [
      { title: "변경 파일 확인", blocks: [
        code(["git status"], ["AI 작업 후 변경되거나 새로 생긴 파일을 확인합니다."]),
        { kind: "steps", items: [
          "예상한 파일만 변경됐는지 확인합니다.",
          "관계없는 파일·.env·불필요한 build/cache/log가 없는지 확인합니다.",
        ] },
      ] },
      { title: "변경 내용 확인", blocks: [
        code(["git diff"], ["아직 스테이지에 올리지 않은 변경 내용을 확인합니다."]),
        text("입문자는 전부 해석할 필요는 없습니다. 예상 밖 대량 삭제·관계없는 수정·Secret·임시 코드가 있는지 확인합니다."),
      ] },
      { title: "테스트·빌드 확인", blocks: [
        text("package.json·프로젝트 지침에서 실제 존재하는 명령만 확인해 실행합니다. AI가 실행했다고 해도 결과를 직접 확인합니다."),
      ] },
      { title: "실제 기능 확인", blocks: [text("가능하면 프로젝트를 직접 실행해 핵심 동작을 확인합니다.")] },
      { title: "오류가 나면", blocks: [{ kind: "steps", items: [
        "Git 단계로 넘어가지 말고 오류 메시지·로그의 API Key·Token·Password·개인정보를 [REDACTED]로 가린 뒤 필요한 부분만 AI 도구에 전달합니다. 로그 전체를 무조건 복사하지 않습니다.",
        "AI가 오류를 수정합니다.",
        "같은 검증을 다시 실행합니다.",
        "성공한 뒤 다음 단계로 넘어갑니다.",
      ] }] },
    ] },
    { title: "STEP 6 · .gitignore / Secret 확인 후 Git 저장", sections: [
      { title: ".gitignore란", blocks: [
        text("GitHub에 올리면 안 되는 파일·저장할 필요 없는 파일을 제외하는 설정입니다. `git add` 전에 확인하면 Secret·불필요한 파일이 포함되는 것을 막을 수 있습니다."),
      ] },
      { title: "기존 .gitignore 확인", blocks: [
        text(".gitignore가 있으면 덮어쓰지 않습니다. 기존 규칙을 유지하고 필요한 항목만 추가합니다. 새 프로젝트에 없으면 실제 스택을 확인한 뒤 기본 규칙을 만듭니다. 아래는 .gitignore에 적는 예시이며 PowerShell에서 실행하는 명령이 아닙니다."),
        code(["node_modules/", ".env", ".env.local", ".env.*.local", "dist/", "build/", ".next/", "*.log"], [
          "Node.js 의존성 폴더를 제외합니다.",
          "실제 인증 정보가 들어갈 수 있는 환경변수 파일을 제외합니다.",
          "로컬 환경변수 파일을 제외합니다.",
          "환경별 로컬 환경변수 파일을 제외합니다.",
          "프로젝트가 dist 폴더에 만드는 빌드 결과를 제외합니다.",
          "프로젝트가 build 폴더에 만드는 빌드 결과를 제외합니다.",
          "프로젝트와 관계없는 항목은 넣지 마세요 (Next.js가 아니면 .next/ 불필요)",
          "로그 파일을 제외합니다.",
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
      { title: "Git 저장 순서", blocks: [
        code(["git add ."], ["현재 폴더 아래 변경 전체를 커밋 후보(스테이지)에 올립니다. 필요한 파일만 올려도 됩니다."]),
        code(["git status"], ["커밋에 포함할 파일을 최종 확인합니다. 이상하면 커밋을 중단합니다."]),
        code(["git diff --cached --stat"], ["커밋에 실제로 들어갈 파일 요약을 확인합니다. 파일 수가 과다하거나 대량 삭제·관계없는 파일이 있으면 중단합니다."]),
        text("필요하면 `git diff --cached`로 스테이지에 올린 변경 내용까지 확인합니다."),
        code(["git branch --show-current"], ["현재 브랜치를 확인합니다. main 직접 push인지 PR 방식인지 프로젝트 방식을 확인합니다."]),
        code(["git remote -v"], ["어느 GitHub 저장소로 push되는지 원격 URL을 확인합니다. 잘못된 저장소에 올리지 않도록 대상을 다시 확인합니다."]),
        code(['git commit -m "작업 내용 요약"'], ["요약을 실제 작업 내용으로 바꿉니다. 커밋은 스테이지의 변경을 Git에 기록하는 작업입니다."]),
        code(["git push"], ["프로젝트 방식대로 원격 저장소에 올립니다. push 후에도 배포가 완료된 것은 아닐 수 있습니다."]),
      ] },
    ] },
    { title: "STEP 7 · GitHub CI / PR 확인", sections: [
      { title: "GitHub에서 확인할 것", blocks: [{ kind: "steps", items: [
        "방금 올린 커밋이 올바른 브랜치에 있는지 확인합니다.",
        "GitHub Actions/CI의 테스트·빌드 상태를 확인합니다.",
        "PR이 필요한 저장소라면 PR·리뷰·merge 상태를 확인합니다.",
      ] }] },
      { title: "git push가 곧 Production은 아닙니다", blocks: [
        text("프로젝트마다 배포 흐름이 다릅니다. feature 브랜치 → Preview/CI → PR → main merge → Production일 수도 있고, main push → 자동 Production일 수도 있습니다. 실제 배포 브랜치·workflow를 먼저 확인합니다."),
      ] },
      { title: "CI가 실패하면", blocks: [
        { kind: "steps", items: ["실패 로그를 확인합니다.", "로그를 AI 도구에 전달합니다.", "오류를 수정합니다.", "다시 검증합니다.", "다시 push하고 CI 결과를 확인합니다."] },
        text("CI 실패를 둔 채 Production 배포만 계속 진행하지 않습니다."),
      ] },
    ] },
    { title: "STEP 8 · 배포 (Vercel / Cloudflare)", sections: [
      { title: "먼저 현재 배포 환경 확인", blocks: [
        text("Vercel과 Cloudflare를 모두 사용해야 하는 것은 아닙니다. 현재 프로젝트의 실제 배포 구성을 확인하고 사용하는 경로만 따르세요. 프론트엔드와 Worker/API를 나누어 두 플랫폼을 함께 쓰는 프로젝트도 있습니다."),
        text("어떤 서비스가 어느 플랫폼에 어느 branch에서 어떤 방식으로 배포되는지 먼저 확인합니다. Vercel·Cloudflare Workers/Pages·GitHub Actions·Wrangler 등 현재 저장소 설정을 기준으로 하며, 배포 구성을 임의로 변경하거나 추가하지 않습니다."),
        text("Preview는 반영 전 확인용이고 Production은 실제 서비스입니다. feature branch·PR → Preview, main/production branch → Production일 수 있지만 예시이며 실제 설정이 우선합니다. 지금 배포할 환경을 먼저 확인합니다. Preview 확인만으로 Production 배포가 완료된 것은 아닙니다."),
      ] },
      { title: "Vercel인 경우", when: "현재 프로젝트가 Vercel에 배포되는 경우에만", blocks: [
        { kind: "steps", items: ["프로젝트 방식대로 push 또는 main merge를 진행합니다.", "Vercel build 결과를 확인합니다.", "Preview 또는 Production 배포를 확인합니다.", "배포 상태를 확인합니다."] },
        text("Git 연동 자동 배포라면 별도 수동 명령이 필요하지 않을 수 있습니다. 자동 배포에 수동 명령을 중복 실행하지 않습니다."),
        text("로컬 .env를 GitHub에 올리지 않고 Vercel Environment Variables에 설정합니다. 변수 이름은 프로젝트에서 확인합니다. Preview·Production 값을 따로 설정할 수 있습니다."),
        { kind: "steps", items: ["실패하면 배포 로그를 확인합니다.", "로그를 AI 도구에 전달합니다.", "오류를 수정합니다.", "테스트합니다.", "commit/push합니다.", "재배포 결과를 확인합니다."] },
      ] },
      { title: "Cloudflare인 경우", when: "현재 프로젝트가 Cloudflare에 배포되는 경우에만", blocks: [
        text("Workers인지 Pages인지 먼저 확인합니다. Git 자동 배포인지 Wrangler 등 기존 CLI 방식인지 현재 프로젝트 설정을 확인합니다."),
        { kind: "steps", items: ["Git 자동 배포라면 프로젝트 방식대로 push/merge합니다.", "배포 진행을 확인합니다.", "배포 상태를 확인합니다."] },
        text("자동 배포에 수동 명령을 중복 실행하지 않습니다. CLI 방식이면 프로젝트에 실제 있는 배포 명령만 실행합니다. `wrangler deploy`를 모든 프로젝트에 강제하지 않습니다."),
        text("Secret은 코드에 넣지 않고 Cloudflare Variables/Secrets에 설정합니다."),
      ] },
    ] },
    { title: "STEP 9 · Production 최종 확인", sections: [
      { title: "실제 서비스 확인", blocks: [
        text("URL이 생겼다고 완료된 것은 아닙니다."),
        { kind: "steps", items: [
          "Production URL에 접속합니다.", "첫 화면이 로딩되는지 확인합니다.", "핵심 기능 1~2개를 실행합니다.",
          "주요 요청이 정상인지 확인합니다.", "Desktop에서 확인합니다.", "Mobile에서 확인합니다.", "브라우저 Console 오류를 확인합니다.",
        ] },
        text("로그인·환경변수·API처럼 Production에서만 달라질 수 있는 기능이 있다면 실제 Production 환경에서도 확인합니다."),
      ] },
      { title: "문제가 생기면", blocks: [{ kind: "steps", items: [
        "로그·브라우저 오류를 확인합니다.", "API Key·Token·Password·개인정보를 [REDACTED]로 가린 뒤 필요한 오류 내용만 AI 도구에 전달합니다. 로그 전체를 무조건 복사하지 않습니다.", "문제를 수정합니다.", "다시 검증합니다.", "commit/push합니다.", "재배포하고 결과를 확인합니다.",
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
  "업무 정리와 보조 도구 수준으로 구현하세요. 시스템이 업무를 자동 실행하는 기능을 임의로 추가하지 마세요.",
  "결과를 만들어 제안하는 보조 기능 중심으로 구현하고 자동 실행 범위는 보수적으로 제한하세요. 예외 검토와 최종 판단·승인은 담당자에게 유지합니다. 자동화 범위를 Level 2~3 수준으로 확대하지 마세요.",
  "반복·규칙 기반 단계는 자동화할 수 있지만 주요 예외와 승인 단계는 담당자에게 유지합니다.",
  "높은 수준의 자동화가 가능하지만 승인·안전·법률·권한과 관련된 단계는 진단 결과대로 유지합니다.",
] as const;

const GATE_CONSTRAINTS = {
  ready: "현재 진단상 구현을 진행할 수 있습니다. 다만 저장소 구조와 실제 연동 조건은 작업 시작 전에 다시 확인하세요.",
  conditional: "'구현 전 확인사항'을 확인하기 전에는 관련 기능을 확정 구현하지 마세요. 확인되지 않은 API·권한·파일 형식·연동 방식을 추측하지 마세요.",
  blocked: "차단 사유가 해결되기 전에는 운영 적용이나 자동 실행 범위를 확대하지 마세요. 가능한 경우 검증용 PoC 또는 준비 작업까지만 진행하세요.",
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

export function buildAllInOnePrompt(rawPlan: AxPlan, _tool: AxToolId, options?: { taskName?: string; prerequisites?: string[]; diagnosis?: AxDiagnosis; context?: string }): string {
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");
  // AI items sometimes carry their own "1)" prefix; the prompt numbers them itself.
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${item.replace(/^\s*(?:\d+[.)]|[①-⑳])\s*/u, "")}`).join("\n");
  const unique = (items: string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))];
  const compact = (value: string) => value.replace(/\s+/gu, "");
  /** Adds extra items unless one already says the same thing (either contains the other). */
  const mergeDistinct = (base: string[], extra: string[]) => unique([...base, ...extra.filter(item => !base.some(existing => compact(existing).includes(compact(item).replace(/\(담당자수행\)$/u, "")) || compact(item).includes(compact(existing))))]);
  const context = [options?.taskName ?? "", options?.context ?? ""].join("\n");
  const plan = guardPlan(rawPlan, context);
  const d = options?.diagnosis;
  const level = d ? automationLevel(d) : null;
  const gate = d ? executionGate(d) : null;
  const manualSteps = d ? d.stepAssessments.filter(s => s.verdict === "사람 유지").map(s => s.step) : [];
  const manualLabels = manualSteps.map(step => `${step} (담당자 수행)`);
  const humanReview = mergeDistinct(plan.humanInLoop, manualLabels);
  const goals = plan.goal, acceptance = plan.acceptance, tests = plan.tests, poc = plan.poc, operation = plan.operation, fallback = plan.fallback;
  const prerequisites = unique([...plan.prerequisites, ...(options?.prerequisites ?? [])]);
  const exceptions = mergeDistinct(plan.exceptions, d?.asIs.exceptions ?? []);
  const introduction = [
    axPromptTitle(options?.taskName),
    "현재 프로젝트 저장소를 먼저 확인한 뒤 아래 요구사항을 구현하세요. 확인되지 않은 파일명·함수명·API·업무 규칙을 추측하지 말고 기존 구현과 실제 업무 자료를 우선 확인하세요.",
  ];
  const sections: { title: string; body: string }[] = [];
  const section = (title: string, ...content: string[]) => sections.push({ title, body: content.filter(Boolean).join("\n\n") });

  if (goals.length) section("작업 목표", bullets(goals),
    humanReview.length ? `구현 후에도 다음 담당자 검토·승인 단계는 유지합니다: ${humanReview.join(", ")}.` : "");
  if (d && level && gate) {
    const a = axes(d);
    section("현재 진단 기준", bullets([
      `자동화 수준: ${level.label.replace(/^L\d+ /, "")} · Level ${level.level}${level.provisional ? " (정보 부족으로 잠정 판정)" : ""}`,
      `자동화 가치: ${a.value}/5`, `기술 실현 가능성: ${a.feasibility}/5`, `담당자 판단 필요도: ${a.judgment}/5`, `운영 위험: ${a.risk}/5`,
      `실행 상태: ${GATE_LABELS[gate]}`,
    ]), `현재 진단은 \`${level.label.replace(/^L\d+ /, "")} · Level ${level.level}\`입니다. ${LEVEL_CONSTRAINTS[level.level]}`,
    `실행 상태는 \`${GATE_LABELS[gate]}\`입니다. ${GATE_CONSTRAINTS[gate]}`);
  }
  section("작업 전 현재 프로젝트 확인", bullets([
    "저장소 지침 파일(AGENTS.md 등)이 있으면 먼저 읽고 그 규칙을 따르세요.",
    "`git status`와 현재 branch로 작업 상태를 확인하세요.",
    "프로젝트 구조, framework/runtime, package manager와 lockfile을 확인하세요.",
    "이 작업과 관련된 기존 구현과 재사용할 수 있는 컴포넌트·함수를 확인하세요.",
    "package scripts에서 테스트·typecheck·빌드·배포 명령과 테스트 방식을 확인하세요.",
    "이 프로젝트가 웹 애플리케이션인지, 로컬 스크립트·CLI·Excel 자동화인지 확인하세요.",
  ]));
  if (d?.asIs.steps.length) section("AS-IS", `현재 업무는 다음 순서로 수행됩니다.${d.asIs.purpose ? ` 목적: ${d.asIs.purpose}` : ""}`, numbered(d.asIs.steps), "자동화 후에도 이 흐름의 목적과 담당자 역할을 유지하세요.");
  else if (plan.asIs.length) section("AS-IS", "현재 업무는 다음과 같이 수행됩니다. 자동화 후에도 이 흐름의 목적과 담당자 역할을 유지하세요.", bullets(plan.asIs));
  if (d?.toBe.length) section("TO-BE", "구현 후에는 다음 역할로 업무가 진행되어야 합니다.", numbered(d.toBe.map(s => `${s.step} — ${OWNER_LABELS[s.owner]}: ${s.description}`)), "담당자 역할로 표시된 단계는 자동화로 대체하지 마세요. 이 중 '작업 범위'의 제외 항목에 해당하는 부분은 이번 작업에서 구현하지 마세요.");
  else if (plan.toBe.length) section("TO-BE", "구현 후 업무는 다음과 같은 상태가 되어야 합니다. 담당자의 승인·검토 역할은 임의로 제거하지 마세요.", bullets(plan.toBe));
  const excluded = mergeDistinct(plan.outOfScope, manualLabels);
  if (plan.inScope.length || excluded.length) section("작업 범위",
    plan.inScope.length ? `### 포함\n\n${bullets(plan.inScope)}` : "",
    excluded.length ? `### 제외\n\n${bullets(excluded)}` : "",
    "제외 범위에 해당하는 기능은 이번 작업에서 임의로 추가하지 마세요.",
    level && level.level <= 2 ? "진단에서 제외되거나 담당자 유지로 분류된 단계를 임의로 자동화하지 마세요." : "",
  );
  if (prerequisites.length) section("구현 전 확인사항", bullets(prerequisites), "확인되지 않은 항목은 '확인 필요'로 유지하고, 확인되지 않은 API나 권한이 있다고 가정해 구현하지 마세요.");
  section("구현 원칙", bullets([
    ...(plan.repositoryFirst ? [plan.repositoryFirst] : []),
    "기존 구현을 우선 재사용하고, 요청 범위 안에서 최소한으로 수정하세요.",
    "요청하지 않은 기능이나 불필요한 신규 라이브러리를 추가하지 마세요.",
    "확인되지 않은 업무 규칙(매칭 기준·계산·반올림·중복 처리)은 추측하지 말고 '확인 필요'로 보고하세요.",
    "확인되지 않은 담당 조직·승인 주체·운영 체계를 지정하지 마세요.",
    "근거 없는 절감률·정확도·오류 감소율 같은 수치 목표를 만들지 마세요.",
    "값을 하드코딩하거나 테스트용 임시 데이터를 실제 로직에 남기지 마세요.",
    "기존 데이터·기능·인증·권한 구조와의 호환성을 유지하세요.",
    "타입·빌드·런타임 오류를 남긴 채 완료로 처리하지 마세요.",
  ]));
  const inputs = d?.asIs.inputs ?? [], outputs = d?.asIs.outputs ?? [];
  if (plan.implementation.length || inputs.length || plan.dataFlow.length) section("구현 요구사항",
    inputs.length ? `### 입력 확인\n\n${bullets(inputs)}\n\n실제 샘플의 구조(시트·헤더·필수 항목·데이터 형식)를 확인한 뒤 처리하세요. 확인 전에는 컬럼명이나 시트 이름을 하드코딩하지 마세요.` : "",
    "### 검증\n\n필수 항목 누락, 빈 행, 읽을 수 없는 값은 정상 데이터와 구분하세요. 오류가 있는 입력을 조용히 정상 처리하지 마세요.",
    plan.implementation.length ? `### 처리 순서\n\n${numbered(plan.implementation)}` : "",
    plan.dataFlow.length ? `### 데이터 흐름\n\n${bullets(plan.dataFlow)}` : "",
    "### 예외 분리\n\n매칭되지 않거나 확인할 수 없는 데이터에 임의의 값을 적용하지 말고 별도로 분리하세요. 자동 삭제·자동 보정은 기존 업무 규칙에 명시된 경우에만 적용하고, 그렇지 않으면 대상 건을 표시만 하세요.",
    `### 결과 생성\n\n${outputs.length ? `결과물: ${outputs.join(", ")}\n\n` : ""}결과에서 정상 처리 건과 검토 필요·처리 실패 건을 구분할 수 있어야 합니다.`,
    humanReview.length ? `### 담당자 검토\n\n${bullets(humanReview)}\n\n위 단계는 담당자가 확인할 수 있도록 유지하고, 자동화 범위를 넓히면서 제거하지 마세요.` : "",
  );
  if (plan.integrations.length) section("외부 연동", bullets(plan.integrations), "연동 대상의 실제 API·권한·인증 방식은 저장소와 공식 설정에서 확인하세요. 확인되지 않은 endpoint나 SDK를 지어내지 마세요.");
  if (exceptions.length) section("예외 처리", "다음 예외 상황을 처리하세요.", bullets(exceptions), "실패·미매칭·확인 불가 데이터를 정상 처리 결과에 섞지 말고, 사용자가 원인과 대상을 확인할 수 있게 구분하세요.");
  if (fallback.length || operation.length) section("문제 발생 시 대응",
    fallback.length ? `### 자동화 실패 시\n\n${bullets(fallback)}\n\n자동화와 기존 수동 절차 사이의 전환 지점을 명확히 유지하세요.` : "",
    operation.length ? `### 운영\n\n${bullets(operation)}\n\n운영 담당자와 장애 대응 담당자는 현재 조직의 실제 운영 체계를 확인한 뒤 반영하세요.` : "",
  );
  if (plan.security.length) section("보안", bullets([
    ...plan.security,
    "secret은 코드에 하드코딩하지 말고 저장소의 기존 secret 관리 방식을 사용하세요.",
    "민감한 데이터를 불필요하게 로그에 남기지 말고 최소 권한 원칙을 유지하세요.",
  ]));
  section("검증 방법",
    "저장소에 실제로 존재하는 검증 명령과 도구를 확인한 뒤 실행하세요. 없는 테스트 framework나 명령을 임의로 설치하지 마세요.",
    `### 정상 케이스\n\n${bullets([...tests, "정의된 샘플 데이터에 대해 자동 결과가 기존 수동 결과와 일치하는지 대조하세요. 허용 오차가 기존 업무에 정의되어 있으면 그 기준을 사용하고, 없으면 임의의 허용 오차를 만들지 마세요."])}`,
    "### 경계값\n\n입력 1건, 빈 입력, 같은 기준값이 여러 건인 경우, 선택 항목이 비어 있는 경우처럼 이 업무의 입력에 해당하는 경계 상황을 확인하세요.",
    `### 실패·예외 케이스\n\n${exceptions.length ? "'예외 처리' 섹션의 각 상황을 재현하고, " : ""}잘못된 형식·필수 항목 누락 같은 실패가 정상 결과로 표시되지 않는지 확인하세요.`,
    poc.length ? `### 사전 검증\n\n${bullets(poc)}` : "",
    "### 회귀 검증\n\n이 작업과 관련된 기존 기능이 이전과 동일하게 동작하는지 확인하세요. 웹 UI를 포함하면 기존 브라우저/E2E 도구가 있을 때 주요 화면을 Desktop과 Mobile에서 확인하고, 도구가 없으면 새로 설치하지 말고 그 사실을 보고하세요.",
  );
  section("Git 반영", bullets([
    "작업 전후로 `git status`, 현재 branch, `git diff`를 확인하고 기존 작업을 덮어쓰지 마세요.",
    "의도한 파일만 `git add <파일>`로 stage하세요. `git add .`로 전체를 추가하지 마세요.",
    "force push, `git reset --hard` 같은 파괴적인 명령을 사용하지 마세요.",
  ]), "stage·commit·push·PR은 사용자 요청 범위, 도구 권한, 저장소 branch/PR 정책이 모두 허용할 때만 진행하세요. 허용되지 않으면 실행하지 말고 현재 Git 상태, 추천 commit 메시지, 다음에 실행할 명령을 보고하세요.");
  section("배포 및 운영 적용", bullets([
    "웹 애플리케이션이면 저장소의 기존 CI/CD·배포 설정과 package scripts에서 배포 방식을 먼저 확인하세요. 배포 플랫폼을 임의로 선택하거나 새 배포 도구를 설치하지 마세요.",
    "로컬 스크립트·CLI·Excel 자동화처럼 웹 배포가 필요 없으면 배포 대신 실행 환경 구성과 운영 적용으로 처리하세요.",
    "배포 방식을 확인할 수 없으면 '배포 방식 확인 필요'로 보고하세요.",
    "Production 배포는 사용자가 배포를 요청했고 권한이 확인된 경우에만 기존 방식으로 실행하세요. 실행하지 않았다면 그 이유와 다음 행동을 보고하세요.",
    "배포 또는 운영 적용을 수행했다면 실제 환경에서 입력 → 처리 → 결과 흐름과 오류 여부를 확인하고, 문제가 있으면 수정 → 재적용 → 동일 시나리오 재검증 순서로 진행하세요.",
  ]));
  section("완료 조건", bullets([
    ...acceptance,
    "요청한 기능이 정상 작동하고 기존 기능과 데이터가 유지됩니다.",
    ...(humanReview.length ? ["담당자 검토·승인 단계가 유지됩니다."] : []),
    "정상·경계·실패 케이스 검증이 통과하고, 실패 건이 정상 결과와 구분됩니다.",
    "타입 오류와 빌드 오류가 없습니다.",
    "배포 또는 운영 적용을 수행한 경우 실제 환경에서 핵심 기능을 검증합니다. 수행하지 않은 경우 사유와 미실행 항목을 명확히 보고합니다.",
    "실행하지 않은 검증은 완료로 보고하지 말고 미실행으로 명시합니다.",
  ]));
  section("완료 보고", "작업이 끝나면 다음 형식으로 보고하세요.", numbered([
    "확인한 현재 구조", "수정한 파일", "구현한 내용", "테스트·검증 결과", "확인 필요로 남긴 업무 규칙", "Git 상태", "배포/운영 적용 결과", "남은 위험 또는 미실행 항목",
  ]), "실제로 수행하지 않은 작업을 완료했다고 보고하지 마세요.");
  return [...introduction, ...sections.filter(section => section.body).map((section, i) => `## ${i + 1}. ${section.title}\n\n${section.body}`)].join("\n\n");
}
