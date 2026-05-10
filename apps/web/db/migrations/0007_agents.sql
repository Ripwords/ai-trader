CREATE TABLE "agent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"trade_date" date NOT NULL,
	"rating" text NOT NULL,
	"confidence" integer NOT NULL,
	"rationale" text NOT NULL,
	"price_at_decision" numeric(18, 6),
	"paper_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_decisions_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"node" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_reflections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"reflected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"horizon_days" integer NOT NULL,
	"realized_return" numeric(8, 4),
	"benchmark_return" numeric(8, 4),
	"alpha" numeric(8, 4),
	"outcome" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "agent_reflections_decision_id_unique" UNIQUE("decision_id")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"trade_date" date NOT NULL,
	"config" jsonb NOT NULL,
	"status" text NOT NULL,
	"resumed_from" uuid,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 4),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reflections" ADD CONSTRAINT "agent_reflections_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decisions_user_symbol_idx" ON "agent_decisions" USING btree ("user_id","symbol","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_run_seq_uq" ON "agent_messages" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_runs_user_symbol_date_idx" ON "agent_runs" USING btree ("user_id","symbol","trade_date");--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("status") WHERE status = 'running';