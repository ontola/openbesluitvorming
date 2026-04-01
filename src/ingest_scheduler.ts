export function computeAllowedIngestConcurrency(options: {
  configuredConcurrency: number;
  availableMemoryBytes: number;
  memoryPerJobMb: number;
  minFreeMemoryMb: number;
}): number {
  const memoryPerJobBytes = options.memoryPerJobMb * 1024 * 1024;
  const minFreeBytes = options.minFreeMemoryMb * 1024 * 1024;
  const usableBytes = Math.max(0, options.availableMemoryBytes - minFreeBytes);
  const memoryBoundConcurrency = Math.max(1, Math.floor(usableBytes / memoryPerJobBytes));

  return Math.max(1, Math.min(options.configuredConcurrency, memoryBoundConcurrency));
}
