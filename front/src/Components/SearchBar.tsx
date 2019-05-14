import * as React from "react";
import { DataSearch } from "@appbaseio/reactivesearch";

export const queryGenerator = (searchTerm: string) => {
  const query = {
    query: {
      simple_query_string: {
        fields,
        default_operator: "or",
        query: searchTerm,
      },
    },
  };
  return query;
};

const fields = ["text", "title", "description", "name"];

const SearchBar: React.FunctionComponent = () => {
  return (
    <DataSearch
      className="SearchBar"
      componentId="searchbox"
      debounce={1200}
      showFilter={false}
      dataField={fields}
      highlight
      autosuggest={false}
      placeholder="Zoek in 109 gemeenten.."
      URLParams={true}
      customQuery={queryGenerator}
      customHighlight={() => ({
        highlight: {
          pre_tags: ["<mark>"],
          post_tags: ["</mark>"],
          fields: {
            text: {},
            title: {},
            name: {},
            description: {},
          },
          fragment_size: 100,
          number_of_fragments: 3,
        },
      })}
    />
  );
};

export default SearchBar;
