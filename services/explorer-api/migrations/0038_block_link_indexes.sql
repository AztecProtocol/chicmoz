CREATE INDEX IF NOT EXISTS "archive_root_idx" ON "archive" USING btree ("root");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "last_archive_root_idx" ON "last_archive" USING btree ("root");--> statement-breakpoint
ALTER TABLE "l2_tip_boundary_mismatch" ADD COLUMN IF NOT EXISTS "rollup_version" bigint;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "l2_tip_boundary_mismatch_unresolved_idx" ON "l2_tip_boundary_mismatch" USING btree ("l2_network_id","height") WHERE "resolved_at" IS NULL;
