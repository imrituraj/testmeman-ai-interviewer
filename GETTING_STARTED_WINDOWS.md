# TestMeMan AI Technical Interviewer: Windows Setup & Getting Started Guide

A complete, step-by-step, zero-hassle guide to setting up and running the entire **TestMeMan AI Technical Interviewer** stack on a Windows machine.

---

## Architecture Overview

When running locally, the project runs three interconnected services:

```mermaid
flowchart LR
    Browser["Candidate Browser\n(http://localhost:5173)"]
    ViteUI["Frontend Vite Demo\n(Port 5173)"]
    API["Cloudflare Worker API\n(Port 8787)"]
    Judge0["Docker Judge0 Sandbox\n(Port 2358)"]
    Gemini["Google Gemini AI\n(Cloud API)"]

    Browser <-->|UI & SSE Stream| ViteUI
    ViteUI <-->|Proxy /interviews & /problems| API
    API <-->|Live Sandboxed Code Execution| Judge0
    API <-->|Socratic Dialogue & Evaluation| Gemini
```

---

## 1. Prerequisites (Install Once)

Make sure you have the following software installed on your Windows machine:

1. **Git for Windows**
   - Download & install: [git-scm.com](https://git-scm.com/download/win)
2. **Node.js (Version >= 22.0.0)**
   - Download & install Node.js v22+ from [nodejs.org](https://nodejs.org/)
   - Verify in PowerShell:
     ```powershell
     node -v
     ```
3. **pnpm (Package Manager)**
   - Install globally via npm:
     ```powershell
     npm install -g pnpm
     ```
   - Verify:
     ```powershell
     pnpm -v
     ```
4. **Docker Desktop for Windows** *(Optional if using Mock Runner)*
   - Download & install: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
   - Ensure the **WSL 2 backend** is enabled in Docker Desktop settings.
   - Start Docker Desktop and make sure the engine is running.

---

## 2. Clone the Repository & Install Dependencies

Open **PowerShell** as Administrator or standard user and run:

```powershell
# 1. Clone your repository
git clone https://github.com/piyushrav1/ai-interview-v.01.git

# 2. Enter directory
cd ai-interview-v.01

# 3. Install all workspace dependencies
pnpm install
```

> [!NOTE]
> If you get a PowerShell script execution error (`cannot be loaded because running scripts is disabled on this system`), run:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```

---

## 3. Configure Environment Variables

The project requires API keys and configuration in two places:

### A. Root `.env` (for tests and scripts)
Create a `.env` file in the project root:
```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
GEMINI_MODEL_INTERVIEWER=gemini-3.1-flash-lite
GEMINI_MODEL_EVALUATOR=gemini-3.1-flash-lite
DATABASE_URL=postgres://postgres:postgres@localhost:5432/interviewer
CODE_RUNNER=judge0
JUDGE0_URL=http://127.0.0.1:2358
```

### B. API Variables (`apps/api/.dev.vars`)
Create a `.dev.vars` file inside `apps/api/`:
```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
GEMINI_MODEL_INTERVIEWER=gemini-3.1-flash-lite
GEMINI_MODEL_EVALUATOR=gemini-3.1-flash-lite
DATABASE_URL=postgres://postgres:postgres@localhost:5432/interviewer
CODE_RUNNER=judge0
JUDGE0_URL=http://127.0.0.1:2358
```

> [!TIP]
> **No Docker installed? No problem!**  
> If you don't have Docker running, you can change `CODE_RUNNER=mock` in both `.env` and `apps/api/.dev.vars`. The platform will automatically use the built-in syntax simulator with full test coverage without needing Docker!

---

## 4. Start the Docker Judge0 Sandbox (If using Docker)

If you are using Docker for sandboxed multi-language code execution:

1. Ensure **Docker Desktop** is open and green (running).
2. If Judge0 is already installed on your system, start it:
   ```powershell
   docker start judge0-server-1 judge0-worker-1 judge0-db-1 judge0-redis-1
   ```
3. Verify that Judge0 is healthy and responding on port 2358:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:2358/about" -Method Get
   ```
   You should see:
   ```text
   version : 1.13.1
   homepage: https://judge0.com
   ```

---

## 5. Start the Live Development Servers

You will run the API backend and the Frontend UI in two separate PowerShell terminal windows.

### Terminal 1: Start the API Backend (Port 8787)
```powershell
cd apps/api
pnpm wrangler dev --port 8787 --ip 127.0.0.1
```
You will see:
```text
Ready on http://127.0.0.1:8787
Starting local server...
```

### Terminal 2: Start the Frontend UI (Port 5173)
Open a second PowerShell window:
```powershell
cd apps/demo
pnpm vite --port 5173 --host 127.0.0.1
```
You will see:
```text
  VITE v6.4.5  ready in 1426 ms
  ➜  Local:   http://127.0.0.1:5173/
```

---

## 6. Open in Browser & Start an Interview

Open your browser and navigate to:
👉 **[http://localhost:5173](http://localhost:5173)**

1. Select your target **Role** (e.g. *Fresher Software Engineer*).
2. Pick a **Coding Problem** (e.g. *Valid Anagram* or *Two Sum*).
3. Select your programming **Language** (*Python, C++, C, Java, or JavaScript*).
4. Check the **Candidate Privacy Consent** box.
5. Click **"Start Interview"**!

The interview will advance through all 9 deterministic phases:
$$\text{plan} \rightarrow \text{intro} \rightarrow \text{problem} \rightarrow \text{coding} \rightarrow \text{followUps} \rightarrow \text{concepts (MCQs)} \rightarrow \text{wrapUp} \rightarrow \text{evaluate} \rightarrow \text{done}$$

---

## 7. Running Verification & Test Suites

You can verify the entire codebase at any time from the project root:

```powershell
# Run the complete test suite (120 tests)
pnpm test

# Run the 20-sample Golden Set benchmark
pnpm test:golden

# Run the Week 6 SLA Latency benchmark (<1.5s TTFT, <60s report turnaround)
pnpm test:sla

# Run TypeScript typechecks across the entire monorepo
pnpm -r typecheck

# Run ESLint across all projects
pnpm -r lint

# Build all packages and applications for production
pnpm build
```

---

## 8. Common Troubleshooting & FAQs

### Q1: The browser shows unstyled HTML text on a dark background.
**Solution:** Ensure the Vite server was started with the workspace root intact. Tailwind CSS v4 automatically scans the monorepo via `@source "../../../packages/ui/src";` in `apps/demo/src/index.css`. Refresh the browser or run `pnpm -r build` once.

### Q2: Port 8787 or 5173 is already in use.
**Solution:** Find the process holding the port and terminate it:
```powershell
# Check what is listening on 8787:
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object OwningProcess

# Kill process (replace PID with the OwningProcess number):
Stop-Process -Id <PID> -Force
```

### Q3: Judge0 code execution fails or times out.
**Solution:**
1. Check that Docker Desktop is running.
2. Run `docker ps` to verify all 4 Judge0 containers (`judge0-server-1`, `judge0-worker-1`, `judge0-db-1`, `judge0-redis-1`) are up.
3. If Docker is unavailable, simply switch `CODE_RUNNER=mock` in `apps/api/.dev.vars` and restart the API server.

---

## 9. Team Git Workflow & Guidelines

- **Author Identity:** All commits to `main` must match your GitHub username and email.
- **Pre-commit Checklist:**
  1. `pnpm test` (All 120 tests passing)
  2. `pnpm -r typecheck` (Zero TS errors)
  3. `pnpm -r lint` (Zero linter errors)

