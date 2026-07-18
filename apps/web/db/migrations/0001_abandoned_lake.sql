CREATE TABLE "price_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"threshold" numeric(18, 6) NOT NULL,
	"note" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"triggered_at" timestamp,
	"triggered_price" numeric(18, 6)
);
--> statement-breakpoint
CREATE INDEX "price_alerts_active_idx" ON "price_alerts" USING btree ("status") WHERE status = 'active';