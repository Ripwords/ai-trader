CREATE TYPE "public"."llm_provider_kind" AS ENUM('anthropic', 'openai', 'google', 'deepseek', 'openrouter');--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "llm_provider_kind" NOT NULL,
	"label" varchar(64) NOT NULL,
	"base_url" text,
	"api_key" text NOT NULL,
	"api_key_hint" varchar(8) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "model_spec" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "estimated_cost_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;