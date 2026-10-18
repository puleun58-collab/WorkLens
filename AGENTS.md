<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## WorkLens 운영 규칙

- 기존 구조·구현·테스트를 먼저 확인하고, 확인하지 않은 파일명·함수명·DB/API 구조를 추측하지 않는다.
- 요청 범위를 넘어 기능을 추가하지 않으며, 기존 정상 동작과 데이터를 유지한다.
- 실제 실행해 확인한 테스트만 통과했다고 보고한다.
- 최신 `main`의 UI를 승인된 기준으로 보존한다. 명확한 브라우저 회귀나 미반영된 사용자 요청이 있을 때만 해당 부분을 최소 수정한다.

법령 조회·검색·파싱·상태 판정 등 법령 관련 로직을 수정한 경우, 작업 완료 전에 기존 15개 법률 실데이터 회귀 세트를 실제 실행하고 결과를 확인한다. 실패 시 코드 회귀와 외부 API 문제를 구분한다. 테스트를 실행하지 않았거나 확인하지 못한 경우 검증 완료로 보고하지 않는다.

법령 검색·식별·파싱·판례/결정례·인용 검증·상태 판정·시점별 처리·API 처리의 결과를 바꾼 경우에도 위 실데이터 회귀 규칙을 따른다. 실패 원인은 코드·외부 API·네트워크·환경으로 구분한다. 색상·간격·테두리·그림자·단순 문구·레이아웃처럼 결과에 영향을 주지 않는 변경에는 강제하지 않는다.

### 문서 관리

기능 수정과 문서 수정은 원칙적으로 별도 작업으로 관리한다.

- 개별 기능·UI·계산 로직을 수정할 때 `사용 가이드`(`src/components/guide/UsageGuide.tsx`)와 `README.md`를 자동으로 수정하지 않는다.
- 사용자가 사용 가이드·README 수정을 명시적으로 요청한 경우에만 해당 문서를 작업 범위에 포함한다.
- 기능 개선으로 기존 안내가 부정확해졌다면 문서를 고치지 말고 변경 필요 여부를 작업 결과에 별도로 보고한다.
- 안내 정확성에 중대한 문제가 생기면 우선 알리고 별도 문서 수정 작업으로 처리한다.
- 사용 가이드에 개발 이력, 버그 수정 내용, 상세 내부 정책을 누적하지 않는다. TIP은 기능별 가장 중요한 주의사항만 간결하게 유지한다.
- README에도 개별 UI 수정 내역이나 내부 디자인 수치를 자동으로 추가하지 않는다.