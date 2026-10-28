export type Migration = {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  resume_state TEXT,
  stop_reason TEXT,
  budget_json TEXT NOT NULL,
  used_json TEXT NOT NULL DEFAULT '{}',
  coordinator_agent_id TEXT NOT NULL,
  parent_meeting_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meetings_session ON meetings(session_id, created_at);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role_snapshot_json TEXT NOT NULL,
  PRIMARY KEY (meeting_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  meeting_id TEXT,
  seq INTEGER NOT NULL,
  sender_type TEXT NOT NULL,
  sender_agent_id TEXT,
  sender_name TEXT,
  target_type TEXT NOT NULL,
  target_agent_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_agent ON message_deliveries(agent_id, state);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  step_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_meeting ON turns(meeting_id, agent_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  assignee_agent_id TEXT,
  created_by TEXT NOT NULL,
  acceptance_criteria TEXT,
  file_globs_json TEXT,
  depends_on_json TEXT,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_agent_id, status);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  agent_id TEXT,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT,
  options_json TEXT,
  decision TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,
  proposed_by_agent_id TEXT,
  accepted_by TEXT,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(session_id, status);

CREATE TABLE IF NOT EXISTS file_claims (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_claims_meeting ON file_claims(meeting_id, status);

CREATE TABLE IF NOT EXISTS change_events (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  turn_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  path TEXT,
  command TEXT,
  exit_code INTEGER,
  before_hash TEXT,
  after_hash TEXT,
  snapshot_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_meeting ON change_events(meeting_id, created_at);
CREATE INDEX IF NOT EXISTS idx_changes_path ON change_events(path, created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  turn_id TEXT,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT,
  decision_note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  meeting_id TEXT,
  turn_id TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  source_message_ids_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_id, scope, status, importance);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  scope TEXT NOT NULL,
  level TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_summaries (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  decisions_json TEXT,
  tasks_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  turn_id TEXT,
  agent_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_meeting ON usage_records(meeting_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  turn_id TEXT,
  agent_id TEXT,
  tool_name TEXT NOT NULL,
  args_json TEXT,
  status TEXT NOT NULL,
  approval_id TEXT,
  duration_ms INTEGER,
  result_summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_meeting ON tool_calls(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS meeting_work (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_meeting ON meeting_work(meeting_id, status, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  caption TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
`
  },
  {
    version: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan';
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, last_opened_at);

ALTER TABLE tool_calls ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);
`
  },
  {
    version: 3,
    sql: `
ALTER TABLE approvals ADD COLUMN session_id TEXT;
ALTER TABLE approvals ADD COLUMN run_id TEXT;
ALTER TABLE approvals ADD COLUMN action_key TEXT;
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_grant ON approvals(action_key, status, scope);

ALTER TABLE change_events ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_changes_session ON change_events(session_id, created_at);

ALTER TABLE snapshots ADD COLUMN session_id TEXT;
ALTER TABLE snapshots ADD COLUMN label TEXT;
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, created_at);
`  },
  {
    version: 4,
    sql: `
ALTER TABLE memory_entries ADD COLUMN session_id TEXT;
ALTER TABLE memory_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_entries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_entries(pinned, status, updated_at);

ALTER TABLE memory_summaries ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_summaries_session ON memory_summaries(session_id, level);
`
  },
  {
    version: 5,
    sql: `
ALTER TABLE meetings ADD COLUMN plan_json TEXT;
ALTER TABLE meetings ADD COLUMN plan_approved_at INTEGER;
ALTER TABLE meetings ADD COLUMN error TEXT;
ALTER TABLE meetings ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN round INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_meeting_seq ON messages(meeting_id, seq);
CREATE INDEX IF NOT EXISTS idx_task_events_meeting ON task_events(meeting_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_meeting ON decisions(meeting_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_agent ON file_claims(agent_id, status);
`
  },
  {
    version: 6,
    sql: `
ALTER TABLE meetings ADD COLUMN final_report_json TEXT;
ALTER TABLE meetings ADD COLUMN build_state_json TEXT;
CREATE INDEX IF NOT EXISTS idx_meetings_parent ON meetings(parent_meeting_id, mode);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(meeting_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_changes_task ON change_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_meeting ON approvals(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_calls (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  meeting_id TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  args_json TEXT,
  result_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_server ON mcp_calls(server_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_session ON mcp_calls(session_id, created_at);
`
  },
  {
    version: 7,
    sql: `
CREATE INDEX IF NOT EXISTS idx_meetings_mode ON meetings(mode, updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_opened_at);
`
  },
  {
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS run_leases (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  meeting_id TEXT,
  kind TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL,
  checkpoint_json TEXT,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_leases_status ON run_leases(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_run_leases_meeting ON run_leases(meeting_id, started_at);
CREATE INDEX IF NOT EXISTS idx_run_leases_session ON run_leases(session_id, started_at);
`
  }
]
