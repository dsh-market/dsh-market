-- One row per install per UTC day: daily actives are COUNT(*) for a day.
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  v TEXT NOT NULL,
  hv TEXT,
  kind TEXT NOT NULL,
  region TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
