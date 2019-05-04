import * as React from "react";
import { DataSearch } from "@appbaseio/reactivesearch";

const SearchBar: React.FunctionComponent = () => {
  return (
    <DataSearch
      className="SearchBar"
      componentId="searchbox"
      debounce={400}
      showFilter={false}
      dataField={["text", "title", "description", "name"]}
      highlight
      autosuggest={false}
      placeholder="Zoek in 109 gemeenten.."
      URLParams={true}
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
