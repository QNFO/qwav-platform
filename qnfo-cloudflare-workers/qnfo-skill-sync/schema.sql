CREATE TABLE IF NOT EXISTS chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  source TEXT DEFAULT 'deepchat',
  provider_id TEXT,
  model_id TEXT,
  title TEXT,
  message_count INTEGER DEFAULT 0,
  summary TEXT,
  error_flag INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created ON chat_logs(created_at);
CREATE TABLE IF NOT EXISTS agent_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  source TEXT,
  category TEXT DEFAULT 'optimization',
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  linked_session TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON agent_issues(status, priority);
CREATE INDEX IF NOT EXISTS idx_issues_created ON agent_issues(created_at);
CREATE TABLE IF NOT EXISTS kaizen_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT UNIQUE,
  body TEXT,
  stats_json TEXT,
  created_at INTEGER
);
