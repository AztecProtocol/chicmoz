-- One-off reset for the open-gap request backoff. Open rows carry request
-- counts from before the backoff existed (in the thousands for gaps that
-- were re-requested every tick), which would hold them at the maximum
-- backoff; this starts every open row over, so it is due on the first
-- reconciliation tick. Fulfilled rows are left as they are.
UPDATE "l2_open_gap" SET "request_count" = 0, "last_requested_at" = NULL WHERE "status" = 'open';
