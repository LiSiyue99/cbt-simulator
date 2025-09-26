-- Backfill assistant_feedbacks -> assistant_chat_messages, then drop table

-- 1) Ensure assistant_chat_messages exists (noop if already)
CREATE TABLE IF NOT EXISTS assistant_chat_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  sender_role varchar(32) NOT NULL,
  sender_id text NOT NULL,
  content text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'read',
  created_at timestamp NOT NULL DEFAULT now()
);

-- 2) Backfill: mark as 'read' to避免打扰
INSERT INTO assistant_chat_messages (id, session_id, sender_role, sender_id, content, status, created_at)
SELECT id, session_id, 'assistant_tech', assistant_id, content, 'read', created_at
FROM assistant_feedbacks
ON CONFLICT DO NOTHING;

-- 3) Drop indexes first if needed (ignore errors)
DROP INDEX IF EXISTS assistant_feedbacks_session_idx;
DROP INDEX IF EXISTS assistant_feedbacks_assistant_idx;

-- 4) Finally drop the table
DROP TABLE IF EXISTS assistant_feedbacks;

