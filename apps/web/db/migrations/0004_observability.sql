CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" varchar(64) NOT NULL,
	"model_spec" varchar(64) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
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
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;