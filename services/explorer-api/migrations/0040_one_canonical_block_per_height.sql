CREATE UNIQUE INDEX IF NOT EXISTS "l2block_one_canonical_per_height_idx" ON "l2Block" USING btree ("version","height") WHERE "l2Block"."orphan_timestamp" IS NULL;
