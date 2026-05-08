CREATE TABLE IF NOT EXISTS "research_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"source" varchar(64) NOT NULL,
	"signal" varchar(16) NOT NULL,
	"confidence" integer NOT NULL,
	"reasoning" text NOT NULL,
	"metadata" jsonb,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_signals" ADD CONSTRAINT "research_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
