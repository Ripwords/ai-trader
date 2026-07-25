CREATE TABLE "investment_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(16) DEFAULT 'auto' NOT NULL,
	"reporting_currency" varchar(8) NOT NULL,
	"market_value" numeric(18, 2) NOT NULL,
	"cost_basis" numeric(18, 2) NOT NULL,
	"unrealized_pl" numeric(18, 2) NOT NULL,
	"day_change" numeric(18, 2),
	"day_change_pct" numeric(10, 4),
	"by_currency" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "investment_snapshots_captured_at_idx" ON "investment_snapshots" USING btree ("captured_at");