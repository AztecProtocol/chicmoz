const sanitizeJobId = (id: string): string => {
  // Job names must be lowercase, alphanumeric, '-', max 63 chars
  return id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .substring(0, 40);
};

export const jobName = (jobId: string): string => `compile-${sanitizeJobId(jobId)}`;
