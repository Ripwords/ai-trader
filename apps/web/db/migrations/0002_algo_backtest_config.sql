ALTER TABLE "algo_strategies" ADD COLUMN "initial_capital" numeric(18,2) DEFAULT '100000' NOT NULL;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "commission_bps" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "slippage_bps" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "sizing_mode" varchar(16) DEFAULT 'fixed_qty' NOT NULL;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "sizing_value" numeric(18,4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "algo_strategies" ADD COLUMN "pyramiding_max" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "algo_strategies" SET "sizing_value" = "qty_per_signal"::numeric;--> statement-breakpoint
ALTER TABLE "algo_strategies" DROP COLUMN "qty_per_signal";--> statement-breakpoint
ALTER TABLE "algo_runs" ADD COLUMN "benchmark_curve" jsonb;--> statement-breakpoint
ALTER TABLE "algo_runs" ADD COLUMN "price_bars" jsonb;
