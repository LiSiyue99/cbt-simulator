-- Drop indexes related to removed columns if they exist
DO $$ BEGIN
  PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'whitelist_assigned_tech_idx';
  IF FOUND THEN EXECUTE 'DROP INDEX IF EXISTS "whitelist_assigned_tech_idx"'; END IF;
  PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'whitelist_assigned_class_idx';
  IF FOUND THEN EXECUTE 'DROP INDEX IF EXISTS "whitelist_assigned_class_idx"'; END IF;
END $$;

-- Drop removed columns if they exist
ALTER TABLE "whitelist_emails" DROP COLUMN IF EXISTS "assigned_tech_asst";
ALTER TABLE "whitelist_emails" DROP COLUMN IF EXISTS "assigned_class_asst";

-- Ensure remaining indexes exist
DO $$ BEGIN
  PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'whitelist_assigned_visitor_idx';
  IF NOT FOUND THEN EXECUTE 'CREATE INDEX "whitelist_assigned_visitor_idx" ON "whitelist_emails" USING btree ("assigned_visitor")'; END IF;
END $$;
