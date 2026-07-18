CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(16) NOT NULL,
	"decision_id" uuid,
	"moomoo_order_id" varchar(64),
	"acc_id" varchar(32),
	"symbol" varchar(32) NOT NULL,
	"side" varchar(8) NOT NULL,
	"qty" integer NOT NULL,
	"price" numeric(18, 6),
	"order_type" varchar(16),
	"trd_env" varchar(16) DEFAULT 'SIMULATE' NOT NULL,
	"status" varchar(32),
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(16) DEFAULT 'auto' NOT NULL,
	"currency" varchar(8),
	"net_worth" numeric(18, 2) NOT NULL,
	"cash" numeric(18, 2) NOT NULL,
	"positions_value" numeric(18, 2) NOT NULL,
	"per_account" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolver" jsonb
);
--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_orders_symbol_idx" ON "paper_orders" USING btree ("symbol","created_at");--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_captured_at_idx" ON "portfolio_snapshots" USING btree ("captured_at");