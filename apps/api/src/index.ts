import { Hono } from "hono";
import { cors } from "hono/cors";
import { interviews } from "./routes/interviews.js";
import { createDevAdapters } from "./adapters/dev.js";
import { GeminiModel } from "./adapters/gemini.js";
import { Judge0Runner } from "./adapters/judge0.js";
import { D1Storage, type D1Database } from "./adapters/d1.js";
import type { AIModel, CodeRunner, Storage, Identity } from "@testmeman/core";
import { getProblem, listProblems } from "@testmeman/core";

export interface Env {
  DATABASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL_INTERVIEWER?: string;
  GEMINI_MODEL_EVALUATOR?: string;
  CODE_RUNNER?: "mock" | "judge0";
  JUDGE0_URL?: string;
  JUDGE0_KEY?: string;
  JUDGE0_HOST?: string;
  AI_INTERVIEWER_KEY?: string;
  CORS_ALLOWED_ORIGINS?: string;
  ALLOW_MOCK_FALLBACK?: string;
  DB?: D1Database;
}

export type ExecutionContext = {
  waitUntil: (promise: Promise<void>) => void;
  passThroughOnException: () => void;
  props: Record<string, unknown>;
};

/**
 * Build adapters from the Cloudflare Workers env object.
 * If GEMINI_API_KEY is available, use the real GeminiModel; otherwise fall back to MockAIModel.
 * If CODE_RUNNER === "judge0" (or configured in prod), use real Judge0Runner directly (do not fall back to mock).
 * Only use mock runner if CODE_RUNNER === "mock".
 * If env.DB is present, use D1Storage. Otherwise use in-memory storage.
 */
export function createAdaptersFromEnv(env: Env): {
  ai: AIModel;
  runner: CodeRunner;
  storage: Storage;
  identity: Identity;
} {
  const apiKey =
    env?.GEMINI_API_KEY ||
    (typeof process !== "undefined" ? process.env?.GEMINI_API_KEY : undefined);
  const modelName =
    env?.GEMINI_MODEL_INTERVIEWER ||
    (typeof process !== "undefined" ? process.env?.GEMINI_MODEL_INTERVIEWER : undefined) ||
    "gemini-3.1-flash-lite";

  const judge0Url =
    env?.JUDGE0_URL ||
    (typeof process !== "undefined" ? process.env?.JUDGE0_URL : undefined);
  const judge0Key =
    env?.JUDGE0_KEY ||
    (typeof process !== "undefined" ? process.env?.JUDGE0_KEY : undefined);
  const judge0Host =
    env?.JUDGE0_HOST ||
    (typeof process !== "undefined" ? process.env?.JUDGE0_HOST : undefined);

  const devAdapters = createDevAdapters();

  // Use real Gemini model if API key is present, otherwise mock
  const ai: AIModel = apiKey
    ? new GeminiModel({
        apiKey,
        modelName,
      })
    : devAdapters.ai;

  // Use real Judge0Runner directly if CODE_RUNNER === "judge0" (or judge0 configured in prod).
  // Only use mock runner if CODE_RUNNER === "mock".
  const isJudge0 =
    env?.CODE_RUNNER === "judge0" ||
    (env?.CODE_RUNNER !== "mock" && (judge0Url || judge0Key));

  const runner: CodeRunner =
    env?.CODE_RUNNER === "mock"
      ? devAdapters.runner
      : isJudge0
        ? new Judge0Runner({
            baseUrl: judge0Url,
            apiKey: judge0Key,
            rapidApiHost: judge0Host,
          })
        : devAdapters.runner;

  // If env.DB is present, use D1Storage; otherwise use in-memory dev storage
  const storage: Storage = env?.DB ? new D1Storage(env.DB) : devAdapters.storage;

  return {
    ai,
    runner,
    storage,
    identity: devAdapters.identity,
  };
}

/**
 * Creates configured Hono app with CORS, Auth, and interview routes.
 */
export function createApp(
  env: Partial<Env> = {},
  customAdapters?: Partial<{
    ai: AIModel;
    runner: CodeRunner;
    storage: Storage;
    identity: Identity;
  }>
): Hono {
  const defaultAdapters = createAdaptersFromEnv(env as Env);
  const adapters = { ...defaultAdapters, ...customAdapters };

  const app = new Hono();

  // CORS middleware: Restrict CORS origin using env CORS_ALLOWED_ORIGINS
  app.use(
    "/*",
    cors({
      origin: (origin, c) => {
        if (!origin) return null;
        const currentCorsEnv =
          (c.env as Env)?.CORS_ALLOWED_ORIGINS ??
          env?.CORS_ALLOWED_ORIGINS ??
          (typeof process !== "undefined" ? process.env?.CORS_ALLOWED_ORIGINS : undefined);

        const allowedOrigins = currentCorsEnv
          ? currentCorsEnv
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean)
          : [];

        if (allowedOrigins.includes("*")) return origin;
        return allowedOrigins.includes(origin) ? origin : null;
      },
    })
  );

  // Auth middleware:
  // If env AI_INTERVIEWER_KEY is set, reject any request (except /health and /favicon.ico)
  // without a matching Authorization: Bearer <key> header with status 401 { "error": "Unauthorized" }.
  // If AI_INTERVIEWER_KEY is not set, allow requests through.
  app.use("/*", async (c, next) => {
    const authKey =
      (c.env as Env)?.AI_INTERVIEWER_KEY ||
      env?.AI_INTERVIEWER_KEY ||
      (typeof process !== "undefined" ? process.env?.AI_INTERVIEWER_KEY : undefined);

    if (!authKey) {
      return next();
    }

    const path = c.req.path;
    if (c.req.method === "OPTIONS" || path === "/health" || path === "/favicon.ico") {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || authHeader !== `Bearer ${authKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  });

  app.route("/interviews", interviews(adapters, env));
  app.get("/problems", (c) => c.json(listProblems()));
  app.get("/problems/:slug", (c) => c.json(getProblem(c.req.param("slug"))));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/favicon.ico", (c) => c.body(null, 204));

  return app;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response {
    const app = createApp(env);
    return app.fetch(request, env, ctx) as unknown as Response;
  },
};
