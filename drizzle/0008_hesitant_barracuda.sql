ALTER TABLE "visitor_instances" ADD COLUMN "is_demo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "visitor_instances_demo_idx" ON "visitor_instances" USING btree ("is_demo");