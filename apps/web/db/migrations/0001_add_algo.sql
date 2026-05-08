CREATE TABLE "algo_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"equity_curve" jsonb,
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
	"qty_per_signal" integer DEFAULT 1 NOT NULL,
	"code" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "algo_runs" ADD CONSTRAINT "algo_runs_strategy_id_algo_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."algo_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_signals" ADD CONSTRAINT "algo_signals_strategy_id_algo_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."algo_strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD CONSTRAINT "algo_strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;