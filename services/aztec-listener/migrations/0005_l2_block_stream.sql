CREATE TABLE IF NOT EXISTS "l2_block_stream_tip" (
	"rollup_version" bigint NOT NULL,
	"tag" varchar NOT NULL,
	"block_number" integer NOT NULL,
	"checkpoint_number" integer,
	"checkpoint_hash" varchar,
	CONSTRAINT "l2_block_stream_tip_rollup_version_tag_pk" PRIMARY KEY("rollup_version","tag")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "l2_block_stream_hash" (
	"rollup_version" bigint NOT NULL,
	"block_number" integer NOT NULL,
	"block_hash" varchar NOT NULL,
	CONSTRAINT "l2_block_stream_hash_rollup_version_block_number_pk" PRIMARY KEY("rollup_version","block_number")
);
