CREATE TABLE "order_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"source" varchar(16) NOT NULL,
	"decision_id" uuid,
	"algo_strategy_id" uuid,
	"acc_id" varchar(32),
	"trd_env" varchar(16) NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"side" varchar(8) NOT NULL,
	"qty" integer NOT NULL,
	"order_type" varchar(24) DEFAULT 'NORMAL' NOT NULL,
	"price" numeric(18, 6),
	"trigger_price" numeric(18, 6),
	"trail_type" varchar(8),
	"trail_value" numeric(18, 6),
	"trail_spread" numeric(18, 6),
	"time_in_force" varchar(8) DEFAULT 'DAY' NOT NULL,
	"session" varchar(16) DEFAULT 'RTH' NOT NULL,
	"rationale" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"moomoo_order_id" varchar(64),
	"error" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "require_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_proposals" ADD CONSTRAINT "order_proposals_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proposals" ADD CONSTRAINT "order_proposals_algo_strategy_id_algo_strategies_id_fk" FOREIGN KEY ("algo_strategy_id") REFERENCES "public"."algo_strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_proposals_pending_idx" ON "order_proposals" USING btree ("status","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "order_proposals_created_at_idx" ON "order_proposals" USING btree ("created_at");