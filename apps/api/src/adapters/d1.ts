import type { Storage } from "@testmeman/core";
import type {
  Interview,
  Turn,
  CodeSnapshot,
  Report,
  Phase,
  Language,
} from "@testmeman/contracts";

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Response<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Response<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Response<T = unknown> {
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
  results?: T[];
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

interface InterviewRow {
  id: string;
  role: string;
  language: string;
  phase: string;
  problemSlug: string;
  conceptQuestions: string | null;
  startTime: number;
  endTime: number | null;
  timeLimitMs: number;
  lastSubmission: string | null;
  lastTestResults: string | null;
  createdAt: number;
}

interface TurnRow {
  id: number;
  interviewId: string;
  role: string;
  text: string;
  turnAt: number;
}

interface CodeSnapshotRow {
  turnId: number;
  interviewId: string;
  language: string;
  source: string;
  timeMs: number;
}

interface ReportRow {
  interviewId: string;
  overallScore: number;
  rubricScores: string;
  strengths: string;
  gaps: string;
  codeReplay: string;
  needsHumanReview: number;
  humanReviewReason: string | null;
  createdAt: number;
}

function extractResults<T>(res: D1Result<T> | T[] | undefined | null): T[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.results)) return res.results;
  return [];
}

/**
 * Cloudflare D1 Storage Adapter implementing Storage from @testmeman/core.
 * Persists interviews, transcript turns, code snapshots, and reports in Cloudflare D1 (SQLite).
 */
export class D1Storage implements Storage {
  constructor(private db: D1Database) {}

  async createInterview(i: Interview): Promise<void> {
    const conceptQuestionsJson = JSON.stringify(i.conceptQuestions ?? []);
    const lastSubmissionJson =
      (i as unknown as { lastSubmission?: unknown }).lastSubmission != null
        ? JSON.stringify((i as unknown as { lastSubmission?: unknown }).lastSubmission)
        : null;
    const lastTestResultsJson =
      (i as unknown as { lastTestResults?: unknown }).lastTestResults != null
        ? JSON.stringify((i as unknown as { lastTestResults?: unknown }).lastTestResults)
        : null;

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO interviews (
          id, role, language, phase, problemSlug, conceptQuestions,
          startTime, endTime, timeLimitMs, lastSubmission, lastTestResults, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        i.id,
        i.role,
        i.language,
        i.phase,
        i.problemSlug ?? "valid-anagram",
        conceptQuestionsJson,
        i.startTime,
        i.endTime != null ? Number(i.endTime) : null,
        i.timeLimitMs,
        lastSubmissionJson,
        lastTestResultsJson,
        Date.now()
      )
      .run();

    if (i.transcript && i.transcript.length > 0) {
      for (const t of i.transcript) {
        await this.appendTurn(i.id, t);
      }
    }

    if (i.codeSnapshots && i.codeSnapshots.length > 0) {
      for (const snap of i.codeSnapshots) {
        await this.saveCodeSnapshot(i.id, snap);
      }
    }
  }

  async getInterview(id: string): Promise<Interview | null> {
    const row = await this.db
      .prepare(
        `SELECT id, role, language, phase, problemSlug, conceptQuestions,
                startTime, endTime, timeLimitMs, lastSubmission, lastTestResults, createdAt
         FROM interviews WHERE id = ?`
      )
      .bind(id)
      .first<InterviewRow>();

    if (!row) return null;

    const turnsRes = await this.db
      .prepare(
        `SELECT id, role, text, turnAt
         FROM turns WHERE interviewId = ? ORDER BY id ASC`
      )
      .bind(id)
      .all<TurnRow>();

    const snapshotsRes = await this.db
      .prepare(
        `SELECT turnId, language, source, timeMs
         FROM code_snapshots WHERE interviewId = ? ORDER BY turnId ASC`
      )
      .bind(id)
      .all<CodeSnapshotRow>();

    const turns = extractResults(turnsRes);
    const snapshots = extractResults(snapshotsRes);

    let conceptQuestions: string[] = [];
    if (row.conceptQuestions) {
      try {
        conceptQuestions =
          typeof row.conceptQuestions === "string"
            ? JSON.parse(row.conceptQuestions)
            : row.conceptQuestions;
      } catch {
        conceptQuestions = [];
      }
    }

    let lastSubmission: unknown = null;
    if (row.lastSubmission) {
      try {
        lastSubmission =
          typeof row.lastSubmission === "string"
            ? JSON.parse(row.lastSubmission)
            : row.lastSubmission;
      } catch {
        lastSubmission = null;
      }
    }

    let lastTestResults: unknown = null;
    if (row.lastTestResults) {
      try {
        lastTestResults =
          typeof row.lastTestResults === "string"
            ? JSON.parse(row.lastTestResults)
            : row.lastTestResults;
      } catch {
        lastTestResults = null;
      }
    }

    const transcript: Turn[] = turns.map((t) => ({
      id: Number(t.id),
      role: t.role as "interviewer" | "candidate",
      text: String(t.text),
      turnAt: Number(t.turnAt),
    }));

    const codeSnapshots: CodeSnapshot[] = snapshots.map((s) => ({
      turnId: Number(s.turnId),
      language: s.language as Language,
      source: String(s.source),
      timeMs: Number(s.timeMs),
    }));

    const interview: Interview & { lastSubmission?: unknown; lastTestResults?: unknown } = {
      id: row.id,
      role: row.role,
      language: row.language as Language,
      phase: row.phase as Phase,
      problemSlug: row.problemSlug || "valid-anagram",
      conceptQuestions,
      startTime: Number(row.startTime),
      endTime: row.endTime != null ? Number(row.endTime) : null,
      timeLimitMs: Number(row.timeLimitMs),
      transcript,
      codeSnapshots,
      lastSubmission,
      lastTestResults,
    };

    return interview as Interview;
  }

  async updatePhase(id: string, phase: Phase): Promise<void> {
    await this.db
      .prepare("UPDATE interviews SET phase = ? WHERE id = ?")
      .bind(phase, id)
      .run();
  }

  async appendTurn(id: string, turn: Turn): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO turns (id, interviewId, role, text, turnAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(turn.id, id, turn.role, turn.text, turn.turnAt)
      .run();
  }

  async saveCodeSnapshot(id: string, snap: CodeSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO code_snapshots (turnId, interviewId, language, source, timeMs)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(snap.turnId, id, snap.language, snap.source, snap.timeMs)
      .run();
  }

  async saveReport(id: string, report: Report): Promise<void> {
    const rubricScoresJson = JSON.stringify(report.rubricScores ?? []);
    const strengthsJson = JSON.stringify(report.strengths ?? []);
    const gapsJson = JSON.stringify(report.gaps ?? []);
    const codeReplayJson = JSON.stringify(report.codeReplay ?? []);
    const needsHumanReview = report.needsHumanReview ? 1 : 0;
    const humanReviewReason = report.humanReviewReason ?? null;

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO reports (
          interviewId, overallScore, rubricScores, strengths, gaps,
          codeReplay, needsHumanReview, humanReviewReason, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        report.overallScore,
        rubricScoresJson,
        strengthsJson,
        gapsJson,
        codeReplayJson,
        needsHumanReview,
        humanReviewReason,
        Date.now()
      )
      .run();
  }

  async getReport(id: string): Promise<Report | null> {
    const row = await this.db
      .prepare(
        `SELECT interviewId, overallScore, rubricScores, strengths, gaps,
                codeReplay, needsHumanReview, humanReviewReason, createdAt
         FROM reports WHERE interviewId = ?`
      )
      .bind(id)
      .first<ReportRow>();

    if (!row) return null;

    const rubricScores =
      typeof row.rubricScores === "string" ? JSON.parse(row.rubricScores) : row.rubricScores;
    const strengths =
      typeof row.strengths === "string" ? JSON.parse(row.strengths) : row.strengths;
    const gaps =
      typeof row.gaps === "string" ? JSON.parse(row.gaps) : row.gaps;
    const codeReplay =
      typeof row.codeReplay === "string" ? JSON.parse(row.codeReplay) : row.codeReplay;

    return {
      overallScore: Number(row.overallScore),
      rubricScores: rubricScores ?? [],
      strengths: strengths ?? [],
      gaps: gaps ?? [],
      codeReplay: codeReplay ?? [],
      needsHumanReview: Boolean(row.needsHumanReview),
      ...(row.humanReviewReason ? { humanReviewReason: row.humanReviewReason } : {}),
    };
  }

  async saveLastSubmission(id: string, submission: unknown): Promise<void> {
    const json = submission != null ? JSON.stringify(submission) : null;
    await this.db
      .prepare("UPDATE interviews SET lastSubmission = ? WHERE id = ?")
      .bind(json, id)
      .run();
  }

  async saveLastTestResults(id: string, results: unknown): Promise<void> {
    const json = results != null ? JSON.stringify(results) : null;
    await this.db
      .prepare("UPDATE interviews SET lastTestResults = ? WHERE id = ?")
      .bind(json, id)
      .run();
  }

  async deleteInterview(id: string): Promise<boolean> {
    const existing = await this.db
      .prepare("SELECT id FROM interviews WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();

    if (!existing) {
      return false;
    }

    await this.db.prepare("DELETE FROM reports WHERE interviewId = ?").bind(id).run();
    await this.db.prepare("DELETE FROM code_snapshots WHERE interviewId = ?").bind(id).run();
    await this.db.prepare("DELETE FROM turns WHERE interviewId = ?").bind(id).run();
    await this.db.prepare("DELETE FROM interviews WHERE id = ?").bind(id).run();

    return true;
  }
}
