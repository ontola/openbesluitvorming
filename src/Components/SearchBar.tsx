import * as React from "react";
import { DataSearch } from "@appbaseio/reactivesearch";
import { GlobalHotKeys } from "react-hotkeys";
import { ids } from "../helpers.ts";
import { keyMap } from "../helpers/keyMap.ts";

const simpleQueryStringChars = ['"', "+", ",", "|", "*", "~", "(", ")"];

const fields = ["text", "title", "description", "name"];

// https://github.com/ontola/ori-search/issues/72
const mustNot = [
  {
    match: {
      "@type": "Membership",
    },
  },
];

export const queryGenerator = (searchTerm: string) => {
  if (searchTerm === undefined) {
    return null;
  }

  let queryPart: { [key: string]: any } = {
    multi_match: {
      fields,
      type: "best_fields",
      operator: "OR",
      query: searchTerm,
    },
  };

  // If any of the special characters are present, assume that the user wants
  // to perform a simpel_query search
  if (
    simpleQueryStringChars.some((substring) => searchTerm.includes(substring))
  ) {
    queryPart = {
      simple_query_string: {
        fields,
        default_operator: "OR",
        query: searchTerm,
      },
    };
  }

  return {
    query: {
      bool: {
        must: [
          queryPart,
          {
            terms: {
              _index: ["ori_*", "osi_*", "owi_*"],
            },
          },
          // Add the MediaObject filter here
          {
            term: {
              "@type": "MediaObject",
            },
          },
        ],
        must_not: mustNot,
      },
    },
  };
};

// How many ms it takes before search is triggered after changing the query value.
const debounce = 500;

const SearchBar: React.FunctionComponent = () => {
  const [query, setQuery] = React.useState<string>("");

  const handlers = {
    // SEARCH: () => ref && ref.focus(),
    SEARCH: (e: KeyboardEvent | undefined) => {
      const wrapper = document.getElementsByClassName(
        "SearchBar",
      )[0] as HTMLElement;
      const inputElement = wrapper.querySelector("input") as HTMLInputElement;
      if (e !== undefined) {
        e.preventDefault();
      }
      inputElement.focus();
    },
  };

  return (
    <GlobalHotKeys
      keyMap={keyMap}
      className="SearchBar__wrapper"
      handlers={handlers}
    >
      <DataSearch
        autoFocus
        // TODO: Focus on bar on SEARCH hotkey
        // ref={(r: HTMLElement) => { setRef(r); }}
        className="SearchBar"
        componentId={ids.searchbox}
        debounce={debounce}
        onChange={setQuery}
        showFilter={false}
        dataField={fields}
        highlight
        autosuggest={false}
        placeholder="Zoeken..."
        value={query}
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
    </GlobalHotKeys>
  );
};

export default SearchBar;
