import { BSON } from "bson";

/**
 * Calls `handler.cb` with `payload` after the BSON round trip the message bus
 * applies (`{ data }` envelope), so bigint, Date and Buffer fields reach the
 * handler in the shape production delivers. The heartbeat always resolves.
 */
export const deliver = async <T>(
  handler: { cb: (data: T, heartbeat: () => Promise<void>) => Promise<void> },
  payload: T,
): Promise<void> => {
  const { data } = BSON.deserialize(BSON.serialize({ data: payload }));
  await handler.cb(data as T, () => Promise.resolve());
};
