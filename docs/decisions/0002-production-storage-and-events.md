# Decision 0002: Durable Storage & Production SSE Error Events

## Status
Accepted

## Context
When deploying `apps/api` to Cloudflare Workers:
1. Isolate lifecycles cause in-memory state to be lost on worker restart or isolate redeployment, resulting in random "Interview not found" errors and lost test execution summaries (`lastSubmission`, `lastTestResults`).
2. In production, if the Gemini API call fails during chat streaming, silent fake responses (from `MockAIModel`) could mislead candidates. We need a visible error event (`type: "error"`) when mock fallback is disabled.
3. API authentication (`AI_INTERVIEWER_KEY`) and CORS origin restrictions are required for secure server-to-server and authorized client consumption.

## Changes
1. **Contracts (`packages/contracts/src/api.ts`)**:
   - Added `"error"` to `MessageEventType` enum (`["delta", "turn", "phase", "starterCode", "done", "error"]`) for streaming error notifications when LLM generation fails in production.
2. **Core Storage Port (`packages/core/src/adapters.ts`)**:
   - Extended `Storage` interface with `getReport(id: string)`, `saveLastSubmission(id: string, submission: unknown)`, `saveLastTestResults(id: string, results: unknown)`, and `deleteInterview(id: string)` to ensure full lifecycle persistence across isolates.
3. **D1 Storage Adapter (`apps/api/src/adapters/d1.ts`) & Migrations (`migrations/0001_d1_schema.sql`)**:
   - Implemented `D1Storage` adapter using Cloudflare D1 with schema covering `interviews`, `turns`, `code_snapshots`, and `reports`.
   - Updated `MemoryStorage` in `apps/api/src/adapters/dev.ts` with matching parity for local and testing environments.
4. **Auth & CORS (`apps/api/src/index.ts`)**:
   - Added Bearer token validation against `AI_INTERVIEWER_KEY` (rejecting unauthorized calls with 401, keeping `/health` and preflight requests open).
   - Added `CORS_ALLOWED_ORIGINS` environment variable filter to restrict cross-origin access.
