import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
import {
  D1Storage,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
  type D1Response,
} from "../src/adapters/d1.js";
import { MemoryStorage } from "../src/adapters/dev.js";
import { PhaseEnum, RubricDimensionEnum, type Interview, type Turn, type CodeSnapshot, type Report } from "@testmeman/contracts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMockD1Database(): D1Database {
  const db = new DatabaseSync(":memory:");
  const schemaPath = path.resolve(__dirname, "../migrations/0001_d1_schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return {
    prepare(query: string): D1PreparedStatement {
      let boundValues: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          boundValues = values.map((v) => (v === undefined ? null : v));
          return stmt;
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const sqlStmt = db.prepare(query);
          const row = sqlStmt.get(...(boundValues as any[])) as Record<string, unknown> | undefined;
          if (!row) return null;
          if (colName) return (row[colName] as T) ?? null;
          return row as T;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const sqlStmt = db.prepare(query);
          const results = sqlStmt.all(...(boundValues as any[])) as T[];
          return {
            results,
            success: true,
            meta: {},
          };
        },
        async run<T = unknown>(): Promise<D1Response<T>> {
          const sqlStmt = db.prepare(query);
          const res = sqlStmt.run(...(boundValues as any[]));
          return {
            success: true,
            meta: { changes: res.changes, lastInsertRowid: res.lastInsertRowid },
          };
        },
      };
      return stmt;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Response<T>[]> {
      const responses: D1Response<T>[] = [];
      for (const s of statements) {
        responses.push(await s.run<T>());
      }
      return responses;
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

describe("D1Storage Adapter", () => {
  let db: D1Database;
  let storage: D1Storage;

  const mockInterview: Interview = {
    id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
    role: "Senior Backend Engineer",
    language: "python",
    phase: PhaseEnum.plan,
    problemSlug: "valid-anagram",
    conceptQuestions: ["Q1: Hash tables", "Q2: OOP"],
    startTime: 1700000000000,
    endTime: null,
    timeLimitMs: 1800000,
    transcript: [
      {
        id: 1,
        role: "interviewer",
        text: "Welcome to the interview!",
        turnAt: 1700000001000,
      },
    ],
    codeSnapshots: [
      {
        turnId: 1,
        language: "python",
        source: "def isAnagram(s, t):\n    pass",
        timeMs: 1000,
      },
    ],
  };

  const mockReport: Report = {
    overallScore: 3,
    rubricScores: [
      {
        dimension: RubricDimensionEnum.problemSolving,
        score: 3,
        evidence: "Good systematic reasoning",
        confidence: "high",
      },
      {
        dimension: RubricDimensionEnum.codeCorrectness,
        score: 4,
        evidence: "All tests pass",
        confidence: "high",
      },
      {
        dimension: RubricDimensionEnum.testingEdgeCases,
        score: 2,
        evidence: "Missed empty string test",
        confidence: "medium",
      },
      {
        dimension: RubricDimensionEnum.complexityReasoning,
        score: 3,
        evidence: "Accurately stated O(N)",
        confidence: "high",
      },
      {
        dimension: RubricDimensionEnum.communication,
        score: 4,
        evidence: "Proactive clarification",
        confidence: "high",
      },
    ],
    strengths: ["Strong algorithmic foundation", "Clean syntax"],
    gaps: ["Edge case diligence"],
    codeReplay: [
      {
        turnId: 1,
        source: "def isAnagram(s, t):\n    return Counter(s) == Counter(t)",
        timeMs: 45000,
      },
    ],
    needsHumanReview: false,
  };

  beforeEach(() => {
    db = createMockD1Database();
    storage = new D1Storage(db);
  });

  describe("createInterview & getInterview", () => {
    it("creates an interview and reconstructs it faithfully", async () => {
      await storage.createInterview(mockInterview);

      const retrieved = await storage.getInterview(mockInterview.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(mockInterview.id);
      expect(retrieved!.role).toBe(mockInterview.role);
      expect(retrieved!.language).toBe(mockInterview.language);
      expect(retrieved!.phase).toBe(mockInterview.phase);
      expect(retrieved!.problemSlug).toBe(mockInterview.problemSlug);
      expect(retrieved!.conceptQuestions).toEqual(mockInterview.conceptQuestions);
      expect(retrieved!.startTime).toBe(mockInterview.startTime);
      expect(retrieved!.endTime).toBeNull();
      expect(retrieved!.timeLimitMs).toBe(mockInterview.timeLimitMs);

      // Verify transcript turns
      expect(retrieved!.transcript).toHaveLength(1);
      expect(retrieved!.transcript[0]).toEqual(mockInterview.transcript[0]);

      // Verify code snapshots
      expect(retrieved!.codeSnapshots).toHaveLength(1);
      expect(retrieved!.codeSnapshots[0]).toEqual(mockInterview.codeSnapshots[0]);
    });

    it("returns null for nonexistent interview id", async () => {
      const nonExistent = await storage.getInterview("00000000-0000-0000-0000-000000000000");
      expect(nonExistent).toBeNull();
    });

    it("orders transcript turns by id ASC regardless of insertion order", async () => {
      const interviewWithoutTurns: Interview = {
        ...mockInterview,
        id: "turn-order-test-id",
        transcript: [],
        codeSnapshots: [],
      };
      await storage.createInterview(interviewWithoutTurns);

      // Append turns out of order
      await storage.appendTurn(interviewWithoutTurns.id, {
        id: 3,
        role: "interviewer",
        text: "Turn 3",
        turnAt: 3000,
      });
      await storage.appendTurn(interviewWithoutTurns.id, {
        id: 1,
        role: "interviewer",
        text: "Turn 1",
        turnAt: 1000,
      });
      await storage.appendTurn(interviewWithoutTurns.id, {
        id: 2,
        role: "candidate",
        text: "Turn 2",
        turnAt: 2000,
      });

      const retrieved = await storage.getInterview(interviewWithoutTurns.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.transcript.map((t) => t.id)).toEqual([1, 2, 3]);
      expect(retrieved!.transcript.map((t) => t.text)).toEqual(["Turn 1", "Turn 2", "Turn 3"]);
    });

    it("orders codeSnapshots by turnId ASC regardless of insertion order", async () => {
      const interviewWithoutSnaps: Interview = {
        ...mockInterview,
        id: "snap-order-test-id",
        transcript: [],
        codeSnapshots: [],
      };
      await storage.createInterview(interviewWithoutSnaps);

      // Save snapshots out of order
      await storage.saveCodeSnapshot(interviewWithoutSnaps.id, {
        turnId: 4,
        language: "python",
        source: "# Snap 4",
        timeMs: 4000,
      });
      await storage.saveCodeSnapshot(interviewWithoutSnaps.id, {
        turnId: 2,
        language: "python",
        source: "# Snap 2",
        timeMs: 2000,
      });

      const retrieved = await storage.getInterview(interviewWithoutSnaps.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.codeSnapshots.map((s) => s.turnId)).toEqual([2, 4]);
      expect(retrieved!.codeSnapshots.map((s) => s.source)).toEqual(["# Snap 2", "# Snap 4"]);
    });
  });

  describe("updatePhase", () => {
    it("updates the phase of an interview in D1", async () => {
      await storage.createInterview(mockInterview);

      await storage.updatePhase(mockInterview.id, PhaseEnum.coding);
      let updated = await storage.getInterview(mockInterview.id);
      expect(updated!.phase).toBe(PhaseEnum.coding);

      await storage.updatePhase(mockInterview.id, PhaseEnum.evaluate);
      updated = await storage.getInterview(mockInterview.id);
      expect(updated!.phase).toBe(PhaseEnum.evaluate);
    });
  });

  describe("saveLastSubmission & saveLastTestResults", () => {
    it("persists and retrieves lastSubmission and lastTestResults", async () => {
      await storage.createInterview(mockInterview);

      const submission = {
        allPassed: true,
        passedCount: 10,
        totalCount: 10,
        failedHiddenCount: 0,
        submittedAt: 1700000050000,
      };
      await storage.saveLastSubmission(mockInterview.id, submission);

      const testResults = [
        { passed: true, hidden: false, timeMs: 14 },
        { passed: true, hidden: true, timeMs: 22 },
      ];
      await storage.saveLastTestResults(mockInterview.id, testResults);

      const retrieved = await storage.getInterview(mockInterview.id);
      const withExtra = retrieved as unknown as {
        lastSubmission: typeof submission;
        lastTestResults: typeof testResults;
      };

      expect(withExtra.lastSubmission).toEqual(submission);
      expect(withExtra.lastTestResults).toEqual(testResults);
    });
  });

  describe("saveReport & getReport", () => {
    it("persists and retrieves a full report", async () => {
      await storage.createInterview(mockInterview);
      await storage.saveReport(mockInterview.id, mockReport);

      const report = await storage.getReport(mockInterview.id);
      expect(report).not.toBeNull();
      expect(report!.overallScore).toBe(mockReport.overallScore);
      expect(report!.rubricScores).toEqual(mockReport.rubricScores);
      expect(report!.strengths).toEqual(mockReport.strengths);
      expect(report!.gaps).toEqual(mockReport.gaps);
      expect(report!.codeReplay).toEqual(mockReport.codeReplay);
      expect(report!.needsHumanReview).toBe(false);
      expect(report!.humanReviewReason).toBeUndefined();
    });

    it("handles human review reason when needsHumanReview is true", async () => {
      await storage.createInterview(mockInterview);
      const flaggedReport: Report = {
        ...mockReport,
        needsHumanReview: true,
        humanReviewReason: "Evaluator timeout fallback triggered",
      };
      await storage.saveReport(mockInterview.id, flaggedReport);

      const report = await storage.getReport(mockInterview.id);
      expect(report).not.toBeNull();
      expect(report!.needsHumanReview).toBe(true);
      expect(report!.humanReviewReason).toBe("Evaluator timeout fallback triggered");
    });

    it("returns null when no report exists for interview", async () => {
      const nonExistent = await storage.getReport("non-existent-id");
      expect(nonExistent).toBeNull();
    });
  });

  describe("deleteInterview (GDPR / Privacy Compliance)", () => {
    it("deletes interview and cascading records, returning true", async () => {
      await storage.createInterview(mockInterview);
      await storage.saveReport(mockInterview.id, mockReport);

      const deleted = await storage.deleteInterview(mockInterview.id);
      expect(deleted).toBe(true);

      const retrievedInterview = await storage.getInterview(mockInterview.id);
      expect(retrievedInterview).toBeNull();

      const retrievedReport = await storage.getReport(mockInterview.id);
      expect(retrievedReport).toBeNull();
    });

    it("returns false when attempting to delete nonexistent interview", async () => {
      const deleted = await storage.deleteInterview("non-existent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("Edge cases & resiliency", () => {
    it("handles corrupted JSON gracefully without crashing", async () => {
      await storage.createInterview(mockInterview);

      // Inject malformed JSON directly into sqlite
      await db
        .prepare("UPDATE interviews SET conceptQuestions = 'invalid{json', lastSubmission = '{bad' WHERE id = ?")
        .bind(mockInterview.id)
        .run();

      const retrieved = await storage.getInterview(mockInterview.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.conceptQuestions).toEqual([]);
      expect((retrieved as any).lastSubmission).toBeNull();
    });

    it("handles D1 .all() returning raw array as well as { results: [] } wrapper", async () => {
      const customDb: D1Database = {
        prepare(q: string) {
          const stmt = db.prepare(q);
          return {
            bind: (...v) => stmt.bind(...v),
            first: (c) => stmt.first(c),
            run: () => stmt.run(),
            // Returns raw array instead of { results: [...] }
            all: async () => {
              const res = await stmt.all();
              return res.results as any;
            },
          };
        },
        batch: (s) => db.batch(s),
        exec: (q) => db.exec(q),
      };

      const customStorage = new D1Storage(customDb);
      await customStorage.createInterview(mockInterview);
      const retrieved = await customStorage.getInterview(mockInterview.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.transcript).toHaveLength(1);
    });
  });

  describe("Feature parity between MemoryStorage and D1Storage", () => {
    it("MemoryStorage supports all extended methods identically", async () => {
      const memStorage = new MemoryStorage();

      await memStorage.createInterview(mockInterview);
      let interview = await memStorage.getInterview(mockInterview.id);
      expect(interview).not.toBeNull();
      expect(interview!.id).toBe(mockInterview.id);

      await memStorage.updatePhase(mockInterview.id, PhaseEnum.followUps);
      interview = await memStorage.getInterview(mockInterview.id);
      expect(interview!.phase).toBe(PhaseEnum.followUps);

      const submission = { allPassed: true, count: 5 };
      await memStorage.saveLastSubmission(mockInterview.id, submission);
      const testResults = [{ passed: true }];
      await memStorage.saveLastTestResults(mockInterview.id, testResults);

      interview = await memStorage.getInterview(mockInterview.id);
      expect((interview as any).lastSubmission).toEqual(submission);
      expect((interview as any).lastTestResults).toEqual(testResults);

      await memStorage.saveReport(mockInterview.id, mockReport);
      const report = await memStorage.getReport(mockInterview.id);
      expect(report).toEqual(mockReport);

      const deleted = await memStorage.deleteInterview(mockInterview.id);
      expect(deleted).toBe(true);

      const afterDelete = await memStorage.getInterview(mockInterview.id);
      expect(afterDelete).toBeNull();
      const afterDeleteReport = await memStorage.getReport(mockInterview.id);
      expect(afterDeleteReport).toBeNull();

      const deleteAgain = await memStorage.deleteInterview(mockInterview.id);
      expect(deleteAgain).toBe(false);
    });
  });
});
