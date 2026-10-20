-- Additive migration. Apply to a test database first; no existing catalog table is modified.
CREATE TABLE IF NOT EXISTS app_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scan', 'covers')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_tasks_active_key ON app_tasks(dedupe_key) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS app_tasks_available ON app_tasks(available_at) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS app_rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_player_metrics (
  day date NOT NULL DEFAULT current_date,
  platform text NOT NULL CHECK (platform IN ('ios','android','web')),
  event text NOT NULL CHECK (event IN ('start','waiting','error','ended')),
  count bigint NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day,platform,event)
);

CREATE TABLE IF NOT EXISTS app_rooms (
  code text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_room_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code text NOT NULL REFERENCES app_rooms(code) ON DELETE CASCADE,
  sender text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_room_events_cursor ON app_room_events(room_code,id);
CREATE TABLE IF NOT EXISTS app_room_members (
  room_code text NOT NULL REFERENCES app_rooms(code) ON DELETE CASCADE,
  client_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_code,client_id)
);
