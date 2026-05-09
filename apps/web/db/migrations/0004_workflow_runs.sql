CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_id" varchar(64) NOT NULL,
	"input_summary" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"total_ms" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
