-- What the mention monitor has already shown somebody (2026-09-03). Main lane block 072-079.
--
-- WITHOUT THIS THE MONITOR IS UNUSABLE AFTER ITS FIRST RUN. Reddit's search returns the same
-- week of posts every time it is asked, so every digest would re-list everything and the
-- reader would stop opening them by about the third one. The whole product of this table is
-- the word "new".
--
-- KEYED ON (source, external_id), NEVER ON THE URL. Reddit serves one post under several
-- URLs -- with and without the slug, old./www., a share suffix -- so a URL key re-surfaces
-- the same thread under a different spelling and looks exactly like a fresh find. Same
-- reasoning as `dedupeKey` in src/lib/mentions/score.ts, which is the one definition.
--
-- IT RECORDS EVERYTHING SCORED, NOT ONLY WHAT WAS SURFACED. Two reasons, and the second is
-- the one that pays:
--   * a candidate that scored 11 today and would score 13 under a tweaked threshold is the
--     only evidence available for whether the threshold is right;
--   * without the below-threshold rows, lowering `SURFACE_THRESHOLD` dumps a month of
--     backlog into one digest as though it were a sudden burst of interest.
--
-- `score` and `surfaced` are stored AS THEY WERE AT THE TIME. They are a record of what a
-- human was shown, not a cache to be recomputed -- so a later change to the scoring rules
-- leaves the history honest instead of silently rewriting what we thought last month.
--
-- NOTHING GATES ON THIS TABLE and nothing user-facing reads it. It is a notebook.
CREATE TABLE IF NOT EXISTS mention_hits (
  source        TEXT        NOT NULL,
  external_id   TEXT        NOT NULL,
  url           TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  community     TEXT,
  author        TEXT,
  -- The post's own time where the source gives one. NULL means "the source did not say",
  -- never "now": a fabricated timestamp would make an old thread look like a live one, which
  -- is the difference between a useful reply and turning up a fortnight late.
  posted_at     TIMESTAMPTZ,
  score         INTEGER     NOT NULL,
  surfaced      BOOLEAN     NOT NULL,
  reasons       TEXT[]      NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Stamped when a human marks it done. NULL is the ordinary state; this exists so the
  -- digest can stop re-listing something already replied to WITHOUT deleting the row, which
  -- would let the next run rediscover it as new.
  actioned_at   TIMESTAMPTZ,
  PRIMARY KEY (source, external_id)
);

-- The digest's only query: newest surfaced hits nobody has dealt with.
CREATE INDEX IF NOT EXISTS mention_hits_open
  ON mention_hits (first_seen_at DESC)
  WHERE surfaced = true AND actioned_at IS NULL;

COMMENT ON TABLE mention_hits IS
  'Mention monitor notebook: every candidate scored, so a digest can say what is NEW. Read-only diagnostic; nothing gates on it.';
