CREATE TABLE users (id uuid PRIMARY KEY, email text, created_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE users IS 'agc:kept: one row per person who signed in';
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, title)
);
CREATE TABLE jobs (
  id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz, done_at timestamptz, last_error text
);
