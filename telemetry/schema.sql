-- One row per install per UTC day: daily actives are COUNT(*) for a day.
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  v TEXT NOT NULL,
  hv TEXT,
  kind TEXT NOT NULL,
  region TEXT NOT NULL,
  -- 1 once the market page was opened that day.
  opened INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, id)
);

-- Existing database (added with the "opened" flag; run once, errors if it is already there):
--   ALTER TABLE pings ADD COLUMN opened INTEGER NOT NULL DEFAULT 0;

-- Dashboard aggregates (see rollup.js), filled by the hourly cron.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,
  -- First day the market page was opened; NULL until it is.
  first_open_day TEXT,
  last_day TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS installs_first_day ON installs (first_day);
CREATE INDEX IF NOT EXISTS installs_first_open_day ON installs (first_open_day);
CREATE INDEX IF NOT EXISTS installs_last_day ON installs (last_day);

-- One JSON row of counts per finished UTC day; no install ids.
CREATE TABLE IF NOT EXISTS rollup (day TEXT PRIMARY KEY, data TEXT NOT NULL, computed_at TEXT NOT NULL) WITHOUT ROWID;

-- Cohort = first day the market was opened; n = how many opened it again k days later (k = 0: cohort size).
CREATE TABLE IF NOT EXISTS retention (cohort TEXT NOT NULL, k INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (cohort, k)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
