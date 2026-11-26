CREATE TABLE IF NOT EXISTS "l2_reorg" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"l2_network_id" varchar NOT NULL,
	"rollup_version" bigint NOT NULL,
	"root_height" bigint NOT NULL,
	"root_hash" varchar NOT NULL,
	"removed_count" integer NOT NULL,
	"observed_at" timestamp NOT NULL,
	"revived_at" timestamp
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "l2_reorg_network_observed_idx" ON "l2_reorg" USING btree ("l2_network_id","observed_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "l2_reorg_block" (
	"reorg_id" bigint NOT NULL REFERENCES "l2_reorg"("id") ON DELETE CASCADE,
	"height" bigint NOT NULL,
	"hash" varchar NOT NULL,
	CONSTRAINT "l2_reorg_block_pkey" PRIMARY KEY ("reorg_id","hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "l2_reorg_block_hash_idx" ON "l2_reorg_block" USING btree ("hash");
