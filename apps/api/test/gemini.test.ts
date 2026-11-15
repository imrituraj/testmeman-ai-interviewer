import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiModel, DEFAULT_GEMINI_MODEL } from "../src/adapters/gemini.js";
import { z } from "zod";

describe("DEFAULT_GEMINI_MODEL", () => {
  it("is defined as gemini-3.1-flash-lite", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.1-flash-lite");
  });
});

describe("GeminiModel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("chat()", () => {
    it("retries with DEFAULT_GEMINI_MODEL when configured model returns 404", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const streamChunks = async function* () {
        yield { text: "Hello " };
        yield { text: "world!" };
      };

      const mockGenerateContentStream = vi.fn().mockImplementation((params: { model: string }) => {
        if (params.model === "gemini-legacy-model") {
          const err = new Error("models/gemini-legacy-model not found: 404");
          return Promise.reject(err);
        }
        if (params.model === DEFAULT_GEMINI_MODEL) {
          return Promise.resolve(streamChunks());
        }
        return Promise.reject(new Error("Unexpected model"));
      });

      const mockClient = {
        models: {
          generateContentStream: mockGenerateContentStream,
          generateContent: vi.fn(),
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: "gemini-legacy-model",
      });

      const chunks: string[] = [];
      for await (const chunk of model.chat({
        system: "You are an interviewer.",
        messages: [{ role: "candidate", text: "Hi" }],
        phase: "coding",
      })) {
        chunks.push(chunk);
      }

      expect(chunks.join("")).toBe("Hello world!");
      expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
      expect(mockGenerateContentStream).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ model: "gemini-legacy-model" })
      );
      expect(mockGenerateContentStream).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: DEFAULT_GEMINI_MODEL })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Model "gemini-legacy-model" not found (404/NOT_FOUND). Retrying with default model "${DEFAULT_GEMINI_MODEL}"`)
      );
    });

    it("throws when DEFAULT_GEMINI_MODEL itself returns 404 (does not retry infinitely)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockGenerateContentStream = vi.fn().mockImplementation(() => {
        return Promise.reject(new Error("models/gemini-3.1-flash-lite not found: 404"));
      });

      const mockClient = {
        models: {
          generateContentStream: mockGenerateContentStream,
          generateContent: vi.fn(),
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: DEFAULT_GEMINI_MODEL,
      });

      const generator = model.chat({
        system: "You are an interviewer.",
        messages: [{ role: "candidate", text: "Hi" }],
        phase: "coding",
      });

      await expect(async () => {
        for await (const _ of generator) {
          // should throw
        }
      }).rejects.toThrow(/not found: 404/);

      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    });

    it("does not retry 404 on non-404 error (e.g. 401 Unauthorized)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockGenerateContentStream = vi.fn().mockImplementation(() => {
        return Promise.reject(new Error("401 Unauthorized: Invalid API Key"));
      });

      const mockClient = {
        models: {
          generateContentStream: mockGenerateContentStream,
          generateContent: vi.fn(),
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: "gemini-custom-model",
      });

      const generator = model.chat({
        system: "You are an interviewer.",
        messages: [{ role: "candidate", text: "Hi" }],
        phase: "coding",
      });

      await expect(async () => {
        for await (const _ of generator) {
          // should throw
        }
      }).rejects.toThrow(/401 Unauthorized/);

      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("structured()", () => {
    const TestSchema = z.object({
      score: z.number(),
      feedback: z.string(),
    });

    it("retries with DEFAULT_GEMINI_MODEL when configured model returns 404", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockGenerateContent = vi.fn().mockImplementation((params: { model: string }) => {
        if (params.model === "gemini-nonexistent") {
          const err = new Error("Resource has been deleted or not found: 404 NOT_FOUND");
          return Promise.reject(err);
        }
        if (params.model === DEFAULT_GEMINI_MODEL) {
          return Promise.resolve({
            text: JSON.stringify({ score: 95, feedback: "Great implementation!" }),
          });
        }
        return Promise.reject(new Error("Unexpected model"));
      });

      const mockClient = {
        models: {
          generateContentStream: vi.fn(),
          generateContent: mockGenerateContent,
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: "gemini-nonexistent",
      });

      const result = await model.structured({
        system: "You are an evaluator.",
        prompt: "Evaluate the code.",
        schema: TestSchema,
      });

      expect(result).toEqual({ score: 95, feedback: "Great implementation!" });
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(mockGenerateContent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ model: "gemini-nonexistent" })
      );
      expect(mockGenerateContent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: DEFAULT_GEMINI_MODEL })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Model "gemini-nonexistent" not found (404/NOT_FOUND). Retrying with default model "${DEFAULT_GEMINI_MODEL}"`)
      );
    });

    it("throws when DEFAULT_GEMINI_MODEL itself returns 404", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockGenerateContent = vi.fn().mockImplementation(() => {
        return Promise.reject(new Error("404 NOT_FOUND"));
      });

      const mockClient = {
        models: {
          generateContentStream: vi.fn(),
          generateContent: mockGenerateContent,
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: DEFAULT_GEMINI_MODEL,
      });

      await expect(
        model.structured({
          system: "You are an evaluator.",
          prompt: "Evaluate the code.",
          schema: TestSchema,
        })
      ).rejects.toThrow(/404 NOT_FOUND/);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it("throws immediately on non-404 error without retrying with default model", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockGenerateContent = vi.fn().mockImplementation(() => {
        return Promise.reject(new Error("400 Bad Request: Invalid parameter"));
      });

      const mockClient = {
        models: {
          generateContentStream: vi.fn(),
          generateContent: mockGenerateContent,
        },
      };

      const model = new GeminiModel({
        client: mockClient,
        modelName: "gemini-custom",
      });

      await expect(
        model.structured({
          system: "You are an evaluator.",
          prompt: "Evaluate the code.",
          schema: TestSchema,
        })
      ).rejects.toThrow(/400 Bad Request/);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
  });
});
