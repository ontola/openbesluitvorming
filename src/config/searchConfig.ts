export const searchFields = ["text", "title", "description", "name"];

// Fields to exclude from _source to improve performance
export const excludedSourceFields = [
  "md_text",
  "text_pages",
  "text_pages.*",
  "content",
  "body",
  "raw_content",
  "full_text",
];

// Common source configuration
export const sourceConfig = {
  excludes: excludedSourceFields,
};

// Common highlight configuration
export const highlightConfig = {
  pre_tags: ["<mark>"],
  post_tags: ["</mark>"],
  fields: {
    text: {
      fragment_size: 150,
      number_of_fragments: 2,
    },
    title: {
      fragment_size: 200,
      number_of_fragments: 1,
    },
    name: {
      fragment_size: 200,
      number_of_fragments: 1,
    },
    description: {
      fragment_size: 150,
      number_of_fragments: 2,
    },
  },
};

// Index patterns
export const indexPatterns = ["ori_*", "osi_*", "owi_*"];

// Common filters
export const commonFilters = {
  indexFilter: {
    terms: {
      _index: indexPatterns,
    },
  },
  mediaObjectFilter: {
    term: {
      "@type": "MediaObject",
    },
  },
  membershipExclusion: {
    match: {
      "@type": "Membership",
    },
  },
};

// Performance settings
export const performanceConfig = {
  debounce: 300,
  defaultSize: 20,
  maxSize: 100,
  timeout: "30s",
  preference: "_local", // Use local shard preference for better caching
};

// Query optimization settings
export const queryOptimization = {
  minimumShouldMatch: "75%",
  defaultOperator: "AND" as const,
  fuzziness: 0,
  boost: 1.0,
  trackScores: true,
  trackTotalHits: true,
};

// Simple query string special characters
export const simpleQueryStringChars = ['"', "+", ",", "|", "*", "~", "(", ")"];

// Base query generator configuration
export const baseQueryConfig = {
  fields: searchFields,
  type: "best_fields" as const,
  operator: queryOptimization.defaultOperator,
  fuzziness: queryOptimization.fuzziness,
};

// Aggregation size limits
export const aggregationConfig = {
  defaultSize: 500,
  maxSize: 1000,
};

// Export a utility function to create consistent query structure
export const createOptimizedQuery = (searchTerm: string) => {
  if (!searchTerm || searchTerm.trim() === "") {
    return null;
  }

  const trimmedTerm = searchTerm.trim();

  let queryPart: any = {
    multi_match: {
      ...baseQueryConfig,
      query: trimmedTerm,
    },
  };

  // Use simple_query_string for special characters
  if (simpleQueryStringChars.some((char) => trimmedTerm.includes(char))) {
    queryPart = {
      simple_query_string: {
        fields: baseQueryConfig.fields,
        default_operator: baseQueryConfig.operator,
        query: trimmedTerm,
        minimum_should_match: baseQueryConfig.minimumShouldMatch,
      },
    };
  }

  return {
    query: {
      bool: {
        must: [
          queryPart,
          commonFilters.indexFilter,
          commonFilters.mediaObjectFilter,
        ],
        must_not: [commonFilters.membershipExclusion],
        boost: queryOptimization.boost,
        minimum_should_match: queryOptimization.minimumShouldMatch,
      },
    },
    _source: sourceConfig,
    highlight: highlightConfig,
    timeout: performanceConfig.timeout,
    track_scores: queryOptimization.trackScores,
    track_total_hits: queryOptimization.trackTotalHits,
  };
};
