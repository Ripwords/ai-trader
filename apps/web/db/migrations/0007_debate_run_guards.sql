-- Keep only the newest running run per (user, symbol) so the unique index can be built.
UPDATE "agent_runs" SET "status" = 'failed', "finished_at" = now(), "error" = 'superseded by a concurrent run on the same symbol'
WHERE "status" = 'running' AND "id" NOT IN (
  SELECT DISTINCT ON ("user_id", "symbol") "id" FROM "agent_runs" WHERE "status" = 'running' ORDER BY "user_id", "symbol", "started_at" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running_per_symbol_uq" ON "agent_runs" USING btree ("user_id","symbol") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "algo_runs_strategy_idx" ON "algo_runs" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "algo_signals_strategy_idx" ON "algo_signals" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_threads_user_idx" ON "chat_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_usage_user_ts_idx" ON "llm_usage" USING btree ("user_id","ts");