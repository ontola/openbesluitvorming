import * as React from "react";
import { DataSearch } from "@appbaseio/reactivesearch";
import { GlobalHotKeys } from "react-hotkeys";
import { ids } from "../helpers";
import { keyMap } from "../helpers/keyMap";

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

  let queryPart: {} = {
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
              _index: ["ori_*", "osi_*", "ggm_*"],
            },
          },
        ],
        must_not: mustNot,
      },
    },
  };
};

// How many ms it takes before search is triggered after changing the query value.
const debounce = 2500;

const SearchBar: React.FunctionComponent = () => {
  const [query, setQuery] = React.useState<string>("");
  const [timer, setTimer] = React.useState<number>();

  React.useEffect(
    () => () => {
      // When the component unmounts, remove the timer.
      clearTimeout(timer);
    },
    [timer]
  );

  const handlers = {
    // SEARCH: () => ref && ref.focus(),
    SEARCH: (e: KeyboardEvent | undefined) => {
      const wrapper = document.getElementsByClassName("SearchBar")[0];
      // @ts-ignore
      const inputElement = wrapper.getElementsByTagName("input")[0];
      if (e !== undefined) {
        e.preventDefault();
      }
      inputElement.focus();
    },
  };

  const handleKey = (e: KeyboardEvent, triggerQuery: Function) => {
    if (e.key === "Enter") {
      triggerQuery();
      // Reset the timer for debouncing.
      clearTimeout(timer);
    }
  };

  const handleChange = (value: string, triggerQuery: Function) => {
    setQuery(value);
    // Set a timer for debouncing, if it's passed, call triggerQuery.
    setTimer(setTimeout(triggerQuery, debounce));
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
        onKeyPress={handleKey}
        onChange={handleChange}
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
