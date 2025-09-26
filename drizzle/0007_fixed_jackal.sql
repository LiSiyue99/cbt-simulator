CREATE TABLE "user_role_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(32) NOT NULL,
	"class_id" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_role_grants" ADD CONSTRAINT "user_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_role_grants_user_idx" ON "user_role_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_role_grants_user_role_idx" ON "user_role_grants" USING btree ("user_id","role");