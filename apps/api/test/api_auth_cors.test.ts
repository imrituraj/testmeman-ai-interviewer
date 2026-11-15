import { describe, it, expect, vi } from "vitest";
import { createApp, createAdaptersFromEnv, type Env } from "../src/index.js";
import { createDevAdapters } from "../src/adapters/dev.js";
import { Judge0Runner } from "../src/adapters/judge0.js";
import { D1Storage } from "../src/adapters/d1.js";
import type { AIModel } from "@testmeman/core";

describe("API Auth Middleware", () => {
  it("allows all requests when AI_INTERVIEWER_KEY is not set", async () => {
    const app = createApp({});

    const res = await app.request("/problems", { method: "GET" });
    expect(res.status).toBe(200);

    const healthRes = await app.request("/health", { method: "GET" });
    expect(healthRes.status).toBe(200);
  });

  it("enforces Authorization header when AI_INTERVIEWER_KEY is set", async () => {
    const secretKey = "test-secret-token-42";
    const app = createApp({ AI_INTERVIEWER_KEY: secretKey });

    // 1. Missing Authorization header -> 401 Unauthorized
    const unauthRes = await app.request("/problems", { method: "GET" });
    expect(unauthRes.status).toBe(401);
    const errBody = await unauthRes.json<{ error: string }>();
    expect(errBody).toEqual({ error: "Unauthorized" });

    // 2. Invalid token -> 401 Unauthorized
    const wrongRes = await app.request("/problems", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongRes.status).toBe(401);

    // 3. Malformed scheme -> 401 Unauthorized
    const malformedRes = await app.request("/problems", {
      method: "GET",
      headers: { Authorization: `Basic ${secretKey}` },
    });
    expect(malformedRes.status).toBe(401);

    // 4. Valid token -> 200 OK
    const validRes = await app.request("/problems", {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    expect(validRes.status).toBe(200);
  });

  it("bypasses auth for /health and /favicon.ico even when AI_INTERVIEWER_KEY is set", async () => {
    const app = createApp({ AI_INTERVIEWER_KEY: "super-secret" });

    const healthRes = await app.request("/health", { method: "GET" });
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json<{ ok: boolean }>();
    expect(healthJson).toEqual({ ok: true });

    const faviconRes = await app.request("/favicon.ico", { method: "GET" });
    expect(faviconRes.status).toBe(204);
  });

  it("bypasses auth for CORS preflight OPTIONS requests", async () => {
    const app = createApp({
      AI_INTERVIEWER_KEY: "super-secret",
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    });

    const optionsRes = await app.request("/interviews", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });

    // Preflight should return 204 No Content, not 401
    expect(optionsRes.status).toBe(204);
  });
});

describe("API CORS Configuration", () => {
  it("restricts CORS when CORS_ALLOWED_ORIGINS is not set", async () => {
    const app = createApp({});

    const res = await app.request("/health", {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows matching origins when CORS_ALLOWED_ORIGINS is configured", async () => {
    const app = createApp({
      CORS_ALLOWED_ORIGINS: "http://localhost:5173,https://app.testmeman.com",
    });

    // Allowed origin 1
    const res1 = await app.request("/health", {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");

    // Allowed origin 2
    const res2 = await app.request("/health", {
      method: "GET",
      headers: { Origin: "https://app.testmeman.com" },
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Access-Control-Allow-Origin")).toBe("https://app.testmeman.com");

    // Disallowed origin
    const resDisallowed = await app.request("/health", {
      method: "GET",
      headers: { Origin: "http://evil.com" },
    });
    expect(resDisallowed.status).toBe(200);
    expect(resDisallowed.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("handles preflight OPTIONS requests for allowed origins", async () => {
    const app = createApp({
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    });

    const preflightRes = await app.request("/problems", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });
});

describe("Error Event Streaming (No Silent Fake Answers in Production)", () => {
  it("streams error event when AI chat fails and ALLOW_MOCK_FALLBACK is false/unset", async () => {
    const devAdapters = createDevAdapters();

    // Mock failing AI model
    const failingAi: AIModel = {
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error("Quota exceeded or Gemini unavailable");
      }),
      structured: vi.fn(),
    };

    const app = createApp(
      { ALLOW_MOCK_FALLBACK: "false" },
      { ai: failingAi, storage: devAdapters.storage }
    );

    // 1. Create an interview
    const createRes = await app.request("/interviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "software_engineer",
        language: "python",
        problemSlug: "two-sum",
      }),
    });
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ id: string }>();

    // 2. Send message -> AI chat fails
    const msgRes = await app.request(`/interviews/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello, ready to start" }),
    });

    expect(msgRes.status).toBe(200);
    expect(msgRes.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await msgRes.text();

    // Verify error event is sent
    expect(text).toContain('data: {"type":"error","content":"Interviewer model unavailable: Quota exceeded or Gemini unavailable"}');
    // Followed by done event
    expect(text).toContain('data: {"type":"done","content":""}');
    // Verify no MockAIModel content is streamed
    expect(text).not.toContain('"type":"delta"');
    expect(text).not.toContain('"type":"turn"');
  });

  it("streams mock fallback when ALLOW_MOCK_FALLBACK is explicitly true", async () => {
    const devAdapters = createDevAdapters();

    const failingAi: AIModel = {
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error("Primary model down");
      }),
      structured: vi.fn(),
    };

    const app = createApp(
      { ALLOW_MOCK_FALLBACK: "true" },
      { ai: failingAi, storage: devAdapters.storage }
    );

    const createRes = await app.request("/interviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "software_engineer",
        language: "python",
        problemSlug: "two-sum",
      }),
    });
    const { id } = await createRes.json<{ id: string }>();

    const msgRes = await app.request(`/interviews/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(msgRes.status).toBe(200);
    const text = await msgRes.text();

    // Should contain mock fallback deltas
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"type":"turn"');
  });
});

describe("createAdaptersFromEnv wiring", () => {
  it("uses real Judge0Runner directly when CODE_RUNNER === 'judge0'", () => {
    const env: Env = {
      CODE_RUNNER: "judge0",
      JUDGE0_URL: "http://127.0.0.1:2358",
    };
    const adapters = createAdaptersFromEnv(env);
    expect(adapters.runner).toBeInstanceOf(Judge0Runner);
  });

  it("uses mock runner when CODE_RUNNER === 'mock'", () => {
    const env: Env = {
      CODE_RUNNER: "mock",
      JUDGE0_URL: "http://127.0.0.1:2358",
    };
    const adapters = createAdaptersFromEnv(env);
    expect(adapters.runner).not.toBeInstanceOf(Judge0Runner);
  });

  it("uses D1Storage when env.DB binding is present", () => {
    const mockDb = {
      prepare: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
    };
    const env: Env = {
      DB: mockDb,
    };
    const adapters = createAdaptersFromEnv(env);
    expect(adapters.storage).toBeInstanceOf(D1Storage);
  });
});
