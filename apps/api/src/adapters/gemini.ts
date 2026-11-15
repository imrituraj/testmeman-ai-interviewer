import type { AIModel } from "@testmeman/core";
import type { Phase } from "@testmeman/contracts";
import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

/**
 * Interface representing the subset of GoogleGenAI client used by GeminiModel.
 * Enables dependency injection for unit testing without network calls.
 */
export interface GeminiClientLike {
  models: {
    generateContentStream(params: {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config?: Record<string, unknown>;
    }): Promise<AsyncIterable<{ text?: string | undefined }>>;
    generateContent(params: {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config?: Record<string, unknown>;
    }): Promise<{ text?: string | null | undefined }>;
  };
}

export interface GeminiModelOptions {
  apiKey?: string;
  modelName?: string;
  client?: GoogleGenAI | GeminiClientLike;
}

/** Check if an error indicates a 404 / NOT_FOUND condition */
function isNotFoundError(err: unknown): boolean {
  const errStr = String(err);
  return (
    errStr.includes("404") ||
    errStr.includes("NOT_FOUND") ||
    errStr.toLowerCase().includes("not found")
  );
}

/**
 * Helper to retry transient Gemini errors (503 Service Unavailable, 429 Rate Limits, Network glitches)
 * with exponential backoff and jitter.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number; operationName?: string } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 600;
  const maxDelay = options.maxDelayMs ?? 4000;
  const op = options.operationName ?? "Gemini API";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const errStr = String(err);
      const isNotFound = isNotFoundError(err);
      const isTransient =
        !isNotFound &&
        (errStr.includes("503") ||
        errStr.includes("429") ||
        errStr.includes("UNAVAILABLE") ||
        errStr.includes("RESOURCE_EXHAUSTED") ||
        errStr.includes("high demand") ||
        errStr.includes("overloaded") ||
        errStr.includes("fetch failed") ||
        errStr.includes("network"));

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const jitter = delay * (0.8 + Math.random() * 0.4);
      console.warn(`[${op}] Transient error (attempt ${attempt}/${maxRetries}): ${errStr.slice(0, 150)}. Retrying in ${Math.round(jitter)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, jitter));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw new Error(`${op} failed after ${maxRetries} attempts`);
}

/**
 * Real Gemini adapter using @google/genai.
 *
 * `chat()` uses `generateContentStream` for word-by-word streaming.
 * `structured()` uses `generateContent` with JSON response mode.
 */
export class GeminiModel implements AIModel {
  private readonly client: any;
  private readonly modelName: string;

  constructor(params: GeminiModelOptions) {
    if (params.client) {
      this.client = params.client;
    } else {
      if (!params.apiKey) {
        throw new Error("GeminiModel requires apiKey when client is not provided");
      }
      this.client = new GoogleGenAI({ apiKey: params.apiKey });
    }
    this.modelName = params.modelName ?? DEFAULT_GEMINI_MODEL;
  }

  async *chat(input: {
    system: string;
    messages: { role: "interviewer" | "candidate"; text: string }[];
    phase: Phase;
    signal?: AbortSignal;
  }): AsyncIterable<string> {
    // Map our message roles to Gemini roles
    const contents = input.messages.map((m) => ({
      role: m.role === "candidate" ? ("user" as const) : ("model" as const),
      parts: [{ text: m.text }],
    }));

    const callStream = async (model: string): Promise<AsyncIterable<{ text?: string | undefined }>> => {
      return (await withRetry(
        () =>
          this.client.models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction: input.system,
            },
          }),
        { operationName: "GeminiModel.chat" }
      )) as AsyncIterable<{ text?: string | undefined }>;
    };

    let targetModel = this.modelName;
    let response: AsyncIterable<{ text?: string | undefined }>;
    try {
      response = await callStream(targetModel);
    } catch (err: unknown) {
      if (isNotFoundError(err) && targetModel !== DEFAULT_GEMINI_MODEL) {
        console.warn(
          `[GeminiModel.chat] Model "${targetModel}" not found (404/NOT_FOUND). Retrying with default model "${DEFAULT_GEMINI_MODEL}"...`
        );
        targetModel = DEFAULT_GEMINI_MODEL;
        response = await callStream(targetModel);
      } else {
        throw err;
      }
    }

    try {
      for await (const chunk of response) {
        if (input.signal?.aborted) break;
        const text = chunk.text;
        if (text) {
          yield text;
        }
      }
    } catch (err: unknown) {
      if (isNotFoundError(err) && targetModel !== DEFAULT_GEMINI_MODEL) {
        console.warn(
          `[GeminiModel.chat] Model "${targetModel}" not found during stream. Retrying with default model "${DEFAULT_GEMINI_MODEL}"...`
        );
        targetModel = DEFAULT_GEMINI_MODEL;
        const fallbackStream = await callStream(targetModel);
        for await (const chunk of fallbackStream) {
          if (input.signal?.aborted) break;
          const text = chunk.text;
          if (text) {
            yield text;
          }
        }
      } else {
        throw err;
      }
    }
  }

  async structured<T>(params: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    temperature?: number;
  }): Promise<T> {
    // Convert the Zod schema description into the prompt since @google/genai
    // doesn't natively accept Zod. We ask for JSON and parse with Zod.
    const schemaDescription = JSON.stringify(schemaToJsonDescription(params.schema), null, 2);

    const fullPrompt = `${params.prompt}\n\nRespond with a JSON object matching this schema:\n${schemaDescription}`;

    const config: Record<string, unknown> = {
      systemInstruction: params.system,
      responseMimeType: "application/json",
    };
    if (params.temperature !== undefined) {
      config.temperature = params.temperature;
    }

    const callGenerate = async (model: string): Promise<{ text?: string | null | undefined }> => {
      return (await withRetry(
        () =>
          this.client.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            config,
          }),
        { operationName: "GeminiModel.structured" }
      )) as { text?: string | null | undefined };
    };

    let targetModel = this.modelName;
    let response: { text?: string | null | undefined };
    try {
      response = await callGenerate(targetModel);
    } catch (err: unknown) {
      if (isNotFoundError(err) && targetModel !== DEFAULT_GEMINI_MODEL) {
        console.warn(
          `[GeminiModel.structured] Model "${targetModel}" not found (404/NOT_FOUND). Retrying with default model "${DEFAULT_GEMINI_MODEL}"...`
        );
        targetModel = DEFAULT_GEMINI_MODEL;
        response = await callGenerate(targetModel);
      } else {
        throw err;
      }
    }

    const text = response.text;
    if (!text) {
      throw new Error("Gemini returned empty response for structured output");
    }

    const parsed: unknown = JSON.parse(text);
    return params.schema.parse(parsed);
  }
}

/**
 * Converts a Zod schema into a simplified JSON schema description object.
 * This is a best-effort conversion for the evaluator schema shape.
 */
function schemaToJsonDescription(schema: ZodType<unknown>): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string; shape?: () => Record<string, ZodType<unknown>>; innerType?: ZodType<unknown>; type?: ZodType<unknown>; checks?: { kind: string; value: unknown }[]; values?: Record<string, string>; options?: ZodType<unknown>[] } })._def;

  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = schemaToJsonDescription(value as ZodType<unknown>);
      }
      return { type: "object", properties };
    }
    case "ZodArray":
      return { type: "array", items: schemaToJsonDescription(def.type as ZodType<unknown>) };
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const checks = def.checks ?? [];
      const result: Record<string, unknown> = { type: "number" };
      for (const check of checks) {
        if (check.kind === "int") result["type"] = "integer";
        if (check.kind === "min") result["minimum"] = check.value;
        if (check.kind === "max") result["maximum"] = check.value;
      }
      return result;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNativeEnum":
      return { type: "string", enum: Object.values(def.values ?? {}) };
    case "ZodEnum":
      return { type: "string", enum: (def as unknown as { values: string[] }).values };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return schemaToJsonDescription(def.innerType as ZodType<unknown>);
    default:
      return { type: "string" };
  }
}
