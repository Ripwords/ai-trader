CREATE TABLE "risk_reports" (
	"user_id" uuid NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"day" date NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "risk_reports_user_id_symbol_day_pk" PRIMARY KEY("user_id","symbol","day")
);
--> statement-breakpoint
ALTER TABLE "risk_reports" ADD CONSTRAINT "risk_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;