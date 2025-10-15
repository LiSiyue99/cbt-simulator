-- Make created_by columns nullable in case 0011 was applied earlier
DO $$ BEGIN
  IF to_regclass('public.deadline_overrides') IS NOT NULL THEN
    ALTER TABLE "deadline_overrides" ALTER COLUMN "created_by" DROP NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.session_deadline_overrides') IS NOT NULL THEN
    ALTER TABLE "session_deadline_overrides" ALTER COLUMN "created_by" DROP NOT NULL;
  END IF;
END $$;