# WorkLens

WorkLens is an ephemeral browser workspace for analyzing, comparing, checking, and extracting evidence from XLSX, CSV, PDF, DOCX, and PPTX files.

## Run

Requires Bun 1.4+ and a Node-compatible runtime supported by Next.js 16.

```bash
bun install
bun run dev
```

Open `http://localhost:3000`. Uploaded files and derived results are isolated by an anonymous HttpOnly browser-session cookie and stored only in the configured temporary directory. The default sliding lifetime is two hours.

## Configuration

- `WORKLENS_TEMP_DIR`: temporary workspace root (defaults to the OS temp directory).
- `WORKLENS_SESSION_TTL_MS`: sliding session lifetime in milliseconds.
- `WORKLENS_MAX_FILE_BYTES`: upload limit; default 50 MiB.
- `WORKLENS_LOCAL_AI_URL`: optional local/on-prem OpenAI-compatible endpoint. Public AI hosts are rejected and there is no external fallback.
- `WORKLENS_LOCAL_AI_MODEL`: optional local model identifier.
- `WORKLENS_LOCAL_AI_HOSTS`: optional comma-separated internal host allowlist.
- `WORKLENS_ALLOW_LOCAL_EPHEMERAL=true`: explicitly allows the single-process temporary adapter under `next start`; omit this in horizontally scaled production deployments.
- `WORKLENS_ORIGIN`: required canonical browser origin in production (for example `https://worklens.internal`); unsafe requests with a different or missing `Origin` are rejected.

The included temporary-store adapter is intended for a single WorkLens server process. It does not provide durable history or recovery after restart.

## Verification

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run test:e2e
```
