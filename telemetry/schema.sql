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
