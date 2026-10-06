ALTER TABLE "agent_decisions" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
UPDATE "agent_decisions" SET "confidence" = NULL WHERE "confidence" = 50 AND "rationale" !~* '(confidence|conviction)';
