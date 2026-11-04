-- SPEC.md AMCP-1 to AMCP-8: people's own agents, connected to the app over MCP. Only hashes of tokens are kept.
-- A person's role in the app's organization, from sign-in: 'owner' sees every connection and blocks tools (AMCP-6).
ALTER TABLE users ADD COLUMN role text;
-- The agent a note was written through, when one was ("via Claude", AMCP-7).
ALTER TABLE notes ADD COLUMN via text;

-- A person's yes to one agent: Read ('read') or Read and act ('act'), for 30 days at most (AMCP-2).
CREATE TABLE mcp_grants (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id   text NOT NULL,
  client_name text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('read', 'act')),
  resource    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_grants_user ON mcp_grants (user_id);
CREATE INDEX mcp_grants_expiry ON mcp_grants (expires_at);

-- Refresh tokens rotate: each is used once, and a second use revokes its grant.
CREATE TABLE mcp_refresh (
  token_hash text PRIMARY KEY,
  grant_id   uuid NOT NULL REFERENCES mcp_grants (id) ON DELETE CASCADE,
  used_at    timestamptz
);
CREATE INDEX mcp_refresh_grant ON mcp_refresh (grant_id);

-- One-use consent requests and codes.
CREATE TABLE mcp_nonces (
  nonce      uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mcp_nonces_expiry ON mcp_nonces (expires_at);

-- Client registrations per address, for the hourly limit.
CREATE TABLE mcp_registrations (
  address text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_registrations_address ON mcp_registrations (address, at);

-- Every tool call: the budgets count these, and the /agents page shows the last few.
CREATE TABLE mcp_calls (
  id       bigserial PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES mcp_grants (id) ON DELETE CASCADE,
  tool     text NOT NULL,
  writes   boolean NOT NULL,
  status   text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_calls_grant ON mcp_calls (grant_id, at);

-- A destructive call waits for its person's yes, bound to the exact tool and arguments (AMCP-5).
CREATE TABLE mcp_approvals (
  id         uuid PRIMARY KEY,
  grant_id   uuid NOT NULL REFERENCES mcp_grants (id) ON DELETE CASCADE,
  tool       text NOT NULL,
  args       jsonb NOT NULL,
  args_hash  text NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX mcp_approvals_call ON mcp_approvals (grant_id, tool, args_hash);

-- Tools an owner has blocked: hidden from every agent, and refused if called.
CREATE TABLE mcp_blocked (
  tool       text PRIMARY KEY,
  blocked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- What each person last pointed at for their agent, kept 10 minutes (AMCP-8).
CREATE TABLE mcp_points (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pick    jsonb NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
