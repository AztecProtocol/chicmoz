/** Rejects with `error()` once `ms` pass; `work` itself keeps running. */
export const withDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
