-- Quizzes (one right answer + explanation) and "when are you free" slot polls.
ALTER TABLE polls ADD COLUMN kind TEXT NOT NULL DEFAULT 'poll';
ALTER TABLE polls ADD COLUMN correct INTEGER;
ALTER TABLE polls ADD COLUMN explanation TEXT NOT NULL DEFAULT '';
