-- Cloudflare D1 SQL Schema for TestMeMan AI Interviewer

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  role TEXT,
  language TEXT,
  phase TEXT,
  problemSlug TEXT,
  conceptQuestions TEXT,
  startTime INTEGER,
  endTime INTEGER,
  timeLimitMs INTEGER,
  lastSubmission TEXT,
  lastTestResults TEXT,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER,
  interviewId TEXT,
  role TEXT,
  text TEXT,
  turnAt INTEGER,
  PRIMARY KEY (interviewId, id),
  FOREIGN KEY (interviewId) REFERENCES interviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_snapshots (
  turnId INTEGER,
  interviewId TEXT,
  language TEXT,
  source TEXT,
  timeMs INTEGER,
  PRIMARY KEY (interviewId, turnId),
  FOREIGN KEY (interviewId) REFERENCES interviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  interviewId TEXT PRIMARY KEY,
  overallScore INTEGER,
  rubricScores TEXT,
  strengths TEXT,
  gaps TEXT,
  codeReplay TEXT,
  needsHumanReview INTEGER,
  humanReviewReason TEXT,
  createdAt INTEGER,
  FOREIGN KEY (interviewId) REFERENCES interviews(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_interview ON turns(interviewId, id);
CREATE INDEX IF NOT EXISTS idx_snapshots_interview ON code_snapshots(interviewId, turnId);
