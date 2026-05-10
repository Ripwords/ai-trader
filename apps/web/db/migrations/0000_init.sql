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
	"role" text DEFAULT 'overall' NOT NULL,
	"reflected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"horizon_days" integer NOT NULL,
	"realized_return" numeric(8, 4),
	"benchmark_return" numeric(8, 4),
	"alpha" numeric(8, 4),
	"outcome" text NOT NULL,
	"text" text NOT NULL
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
	"finished_at" timestamp with time zone,
	"final_state" jsonb
);
--> statement-breakpoint
CREATE TABLE "algo_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"equity_curve" jsonb,
	"benchmark_curve" jsonb,
	"price_bars" jsonb,
	"trades" jsonb,
	"metrics" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "algo_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" uuid NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"side" varchar(8) NOT NULL,
	"qty" integer NOT NULL,
	"price" numeric(18, 6),
	"order_id" varchar(64),
	"error" text
);
--> statement-breakpoint
CREATE TABLE "algo_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"cadence" varchar(8) NOT NULL,
	"code" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"initial_capital" numeric(18, 2) DEFAULT '100000' NOT NULL,
	"commission_bps" integer DEFAULT 10 NOT NULL,
	"slippage_bps" integer DEFAULT 5 NOT NULL,
	"sizing_mode" varchar(16) DEFAULT 'fixed_qty' NOT NULL,
	"sizing_value" numeric(18, 4) DEFAULT '1' NOT NULL,
	"pyramiding_max" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" jsonb NOT NULL,
	"tool_calls" jsonb,
	"reasoning" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reflections" ADD CONSTRAINT "agent_reflections_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_runs" ADD CONSTRAINT "algo_runs_strategy_id_algo_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."algo_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_signals" ADD CONSTRAINT "algo_signals_strategy_id_algo_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."algo_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD CONSTRAINT "algo_strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decisions_user_symbol_idx" ON "agent_decisions" USING btree ("user_id","symbol","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_run_seq_uq" ON "agent_messages" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reflections_decision_role_uq" ON "agent_reflections" USING btree ("decision_id","role");--> statement-breakpoint
CREATE INDEX "agent_runs_user_symbol_date_idx" ON "agent_runs" USING btree ("user_id","symbol","trade_date");--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("status") WHERE status = 'running';