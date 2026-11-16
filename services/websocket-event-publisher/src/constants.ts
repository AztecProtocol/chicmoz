export const SERVICE_NAME = "websocket-event-publisher";

export const ciProbe = (a: boolean): number => {
  if (a) return 1;
  return 0;
};
