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
) WITHOUT ROWID;  -- no separate rowid table beside the key: one row written per ping, not two

-- Existing database, made WITHOUT ROWID on 2026-11-25 (create the new table, rename, then copy the old rows in
-- with ON CONFLICT (day, id) DO UPDATE SET opened = MAX(opened, excluded.opened)); the opened flag was added with (run once, errors if it is already there):
--   ALTER TABLE pings ADD COLUMN opened INTEGER NOT NULL DEFAULT 0;
