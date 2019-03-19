import React, { Component } from "react";
import {
  ReactiveBase,
  CategorySearch,
  ResultList,
  DateRange,
  MultiList,
  SelectedFilters,
} from "@appbaseio/reactivesearch";
import "./App.css";

interface ORIItemType {
  _id: string;
  _score: number;
  _index: string;
  _type: string;
  // TODO: specify?
  _source: any;
  _version?: number;
  _explanation?: any;
  content_type: string;
  date_modified: string;
  fields?: any;
  highlight?: any;
  hightlight: string;
  inner_hits?: any;
  matched_queries?: string[];
  name: string;
  original_url: string;
  size_in_bytes: string;
  sort?: string[];
  text: string;
  title: string;
}

const ResultCard = (res: ORIItemType) => {
  const date = new Date(res.date_modified);
  return {
    title: res.name,
    description: (
      <div>
        <p>{date.toLocaleDateString()}</p>
        <p>{res._type}</p>
        <p>{res._index}</p>
        <p>{res.content_type}</p>
        <p><span dangerouslySetInnerHTML={{ __html: res.highlight.text }}/></p>
      </div>
    ),
    url: res.original_url,
  };
};

const NoResults = () =>
  <p>no results</p>;

  const allComponentIds = [
  "searchbox",
  "gemeenten",
  "daterange",
];

class App extends Component {
  render() {
    return (
      <ReactiveBase
        app="ori_*"
        url="http://localhost:8080/search/"
      >
        <div>
          <CategorySearch
            componentId="searchbox"
            dataField={["text", "title"]}
            categoryField="@type"
            highlight
            placeholder="Zoek in 109 gemeenten.."
            URLParams={true}
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
          <SelectedFilters />
          <DateRange
            componentId="daterange"
            dataField="date_modified"
            title="Datum"
            placeholder={{
              start: "Van...",
              end: "Tot...",
            }}
            numberOfMonths={2}
            queryFormat="date"
            autoFocusEnd={true}
            showClear={true}
            showFilter={true}
            filterLabel="Date"
            URLParams={true}
          />
          <MultiList
            componentId="gemeenten"
            dataField="_index"
            title="Gemeenten"
            size={100}
            sortBy="count"
            queryFormat="or"
            selectAllLabel="Alle gemeenten"
            showCheckbox={true}
            showCount={true}
            showSearch={true}
            placeholder="Zoek gemeente..."
            react={{
              and: ["searchbox", "daterange"],
            }}
            showFilter={true}
            filterLabel="City"
            URLParams={true}
            loader="Loading ..."
          />
          <ResultList
            componentId="ResultList01"
            dataField="date_modified"
            stream={true}
            sortBy="desc"
            size={12}
            pagination={false}
            showResultStats={true}
            onNoResults={NoResults}
            loader="Loading Results.."
            react={{
              // When these components change, update the results
              and: allComponentIds,
            }}
            renderData={ResultCard}
          />
        </div>
      </ReactiveBase>
    );
  }
}

export default App;
