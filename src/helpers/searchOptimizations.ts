import { sourceConfig, highlightConfig, performanceConfig } from "../config/searchConfig";

/**
 * Applies consistent source exclusions to any Elasticsearch query
 * to improve performance by excluding large text fields
 */
export const applySourceOptimization = (query: any) => {
  if (!query) return query;

  return {
    ...query,
    _source: sourceConfig,
  };
};

/**
 * Applies consistent highlight configuration to any Elasticsearch query
 */
export const applyHighlightOptimization = (query: any) => {
  if (!query) return query;

  return {
    ...query,
    highlight: highlightConfig,
  };
};

/**
 * Applies performance optimizations including timeout and tracking settings
 */
export const applyPerformanceOptimizations = (query: any) => {
  if (!query) return query;

  return {
    ...query,
    timeout: performanceConfig.timeout,
    track_scores: true,
    track_total_hits: true,
  };
};

/**
 * Applies all optimizations to a query
 */
export const applyAllOptimizations = (query: any) => {
  return applyPerformanceOptimizations(
    applyHighlightOptimization(
      applySourceOptimization(query)
    )
  );
};

/**
 * Creates optimized ReactiveSearch component props
 */
export const getOptimizedReactiveSearchProps = (componentId: string, size: number = performanceConfig.defaultSize) => ({
  componentId,
  size,
  timeout: performanceConfig.timeout,
  includeFields: ["*"],
  excludeFields: sourceConfig.excludes,
  highlight: true,
  highlightConfig: highlightConfig,
  innerClass: {
    input: `${componentId}__input`,
    list: `${componentId}__list`,
    poweredBy: `${componentId}__powered-by`,
  },
  URLParams: true,
});

/**
 * Optimizes aggregation queries by ensuring they don't return unnecessary _source data
 */
export const optimizeAggregationQuery = (query: any, aggConfig: any) => {
  return {
    ...applySourceOptimization(query),
    size: 0, // No documents needed for aggregations
    aggs: aggConfig,
    timeout: performanceConfig.timeout,
  };
};

/**
 * Creates a preference string for consistent shard routing
 * This helps with caching and performance
 */
export const createSearchPreference = (userId?: string, sessionId?: string) => {
  if (userId) {
    return `user_${userId}`;
  }
  if (sessionId) {
    return `session_${sessionId}`;
  }
  return performanceConfig.preference;
};

/**
 * Validates and sanitizes search terms to prevent performance issues
 */
export const sanitizeSearchTerm = (term: string): string => {
  if (!term || typeof term !== 'string') {
    return '';
  }

  // Remove excessive whitespace
  const trimmed = term.trim().replace(/\s+/g, ' ');

  // Limit length to prevent extremely long queries
  const maxLength = 200;
  if (trimmed.length > maxLength) {
    return trimmed.substring(0, maxLength);
  }

  return trimmed;
};

/**
 * Creates a debounced search function with optimized settings
 */
export const createDebouncedSearch = (searchFunction: (term: string) => void, delay: number = performanceConfig.debounce) => {
  let timeoutId: NodeJS.Timeout;

  return (searchTerm: string) => {
    clearTimeout(timeoutId);

    const sanitized = sanitizeSearchTerm(searchTerm);

    if (sanitized.length < 2) {
      // Don't search for very short terms
      return;
    }

    timeoutId = setTimeout(() => {
      searchFunction(sanitized);
    }, delay);
  };
};

/**
 * Monitors search performance and logs slow queries
 */
export const createSearchPerformanceMonitor = (componentName: string) => {
  return {
    start: (query: string) => {
      const startTime = performance.now();

      return {
        end: (resultCount?: number) => {
          const endTime = performance.now();
          const duration = endTime - startTime;

          if (duration > 1000) { // Log queries taking more than 1 second
            console.warn(`Slow search in ${componentName}:`, {
              query,
              duration: `${duration.toFixed(2)}ms`,
              resultCount,
              timestamp: new Date().toISOString(),
            });
          }
        },
      };
    },
  };
};

/**
 * Common error handling for search operations
 */
export const handleSearchError = (error: any, componentName: string, query: string) => {
  console.error(`Search error in ${componentName}:`, {
    error: error.message || error,
    query,
    timestamp: new Date().toISOString(),
    stack: error.stack,
  });

  // You can extend this to send to error reporting service
  // errorReportingService.captureException(error, { componentName, query });
};

/**
 * Creates a search result transformer that applies consistent formatting
 */
export const createSearchResultTransformer = (componentName: string) => {
  return (results: any[]) => {
    return results.map((result, index) => ({
      ...result,
      _meta: {
        componentName,
        position: index,
        timestamp: new Date().toISOString(),
      },
      // Ensure highlight data is properly formatted
      highlight: result.highlight || {},
      // Add computed fields if needed
      _score_normalized: result._score ? Math.round(result._score * 100) / 100 : 0,
    }));
  };
};
