import * as React from 'react';
import { CategorySearch } from '@appbaseio/reactivesearch';

interface SearchBarProps {
}

const SearchBar: React.FunctionComponent<SearchBarProps> = (props) => {
  return (
    <CategorySearch
      componentId="searchbox"
      dataField={["text", "title"]}
      categoryField="@type"
      highlight
      placeholder="Zoek in 109 gemeenten.."
      URLParams={true}
      onChange={() => console.log("QUERY CHANGED")}
      customHighlight={() => ({
        highlight: {
          pre_tags: ["<b>"],
          post_tags: ["</b>"],
          fields: {
            text: {},
            title: {},
          },
          fragment_size: 100,
          number_of_fragments: 3,
        },
      })}
    />
  );
};

export default SearchBar;
