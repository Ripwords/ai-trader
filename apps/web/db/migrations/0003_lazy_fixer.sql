CREATE TABLE "valuation_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"run_id" uuid,
	"fair_value" numeric(18, 6),
	"current_price" numeric(18, 6) NOT NULL,
	"margin_of_safety_pct" numeric(10, 6),
	"data_quality" varchar(16) NOT NULL,
	"veto_triggered" boolean DEFAULT false NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "valuation_snapshots" ADD CONSTRAINT "valuation_snapshots_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "valuation_snapshots_symbol_created_idx" ON "valuation_snapshots" USING btree ("symbol","created_at");