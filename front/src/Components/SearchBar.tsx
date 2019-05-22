import * as React from "react";
import { DataSearch } from "@appbaseio/reactivesearch";
import { GlobalHotKeys } from "react-hotkeys";

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
  // const [ref, setRef] = React.useState<HTMLElement | null>(null);
  const handlers = {
    // SEARCH: () => ref && ref.focus(),
    SEARCH: (e: KeyboardEvent | undefined) => {
      const wrapper = document.getElementsByClassName("SearchBar")[0];
      // @ts-ignore
      const inputElement = wrapper.getElementsByTagName("input")[0];
      console.log(inputElement);
      if (e !== undefined) {
        e.preventDefault();
      }
      inputElement.focus();
    },
  };

  return (
    <GlobalHotKeys
      className="SearchBar__wrapper"
      handlers={handlers}
    >
      <DataSearch
        autoFocus
        // TODO: Focus on bar on SEARCH hotkey
        // ref={(r: HTMLElement) => { setRef(r); }}
        className="SearchBar"
        componentId="searchbox"
        debounce={200}
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
    </GlobalHotKeys>
  );
};

export default SearchBar;
