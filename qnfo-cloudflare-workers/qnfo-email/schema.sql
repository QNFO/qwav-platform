-- qnfo-email D1 Schema Migration
-- Runs against qnfo-audit database (35e2e573-92f3-46ac-83c6-22f6429fc5e5)
-- Apply: npx wrangler d1 execute qnfo-audit --file=schema.sql

-- Email archive — every inbound email stored here
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  headers_json TEXT,
  classification TEXT DEFAULT 'general',
  status TEXT DEFAULT 'received',
  processing_ms INTEGER,
  received_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender);
CREATE INDEX IF NOT EXISTS idx_emails_recipient ON emails(recipient);
CREATE INDEX IF NOT EXISTS idx_emails_classification ON emails(classification);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);

-- Filtering rules engine
CREATE TABLE IF NOT EXISTS email_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT DEFAULT 'filter',
  field TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'accept',
  reply_template TEXT,
  priority INTEGER DEFAULT 0,
  enabled BOOLEAN DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_filters_enabled ON email_filters(enabled);

-- Seed default filters
INSERT OR IGNORE INTO email_filters (field, pattern, action, priority, rule_type)
VALUES 
  ('from', 'noreply', 'accept', 0, 'filter'),
  ('from', 'no-reply', 'accept', 0, 'filter'),
  ('from', 'mailer-daemon', 'accept', 0, 'filter'),
  ('from', 'bounce', 'accept', 0, 'filter');
