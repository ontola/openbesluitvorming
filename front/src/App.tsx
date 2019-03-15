import React, { Component } from "react";
import { ReactiveBase, CategorySearch, SingleRange, ResultList } from "@appbaseio/reactivesearch";
import "./App.css";

class App extends Component {
  render() {
    return (
      <ReactiveBase
        app="ori_*"
        url="https://api.openraadsinformatie.nl/v1/elastic/"
      >
        <div>
          <CategorySearch
            componentId="searchbox"
            dataField="model"
            categoryField="brand.keyword"
            placeholder="Zoek in 109 gemeenten.."
          />
          Hello ReactiveSearch!
          <SingleRange
            componentId="ratingsfilter"
            dataField="rating"
            title="Filter by ratings"
            data={[
              { start: 4, end: 5, label: "4 stars and up" },
              { start: 3, end: 5, label: "3 stars and up" },
            ]}
            showRadio={true}
          />
          <ResultList
            componentId="ResultList01"
            dataField="ratings"
            stream={true}
            sortBy="desc"
            size={8}
            pagination={false}
            showResultStats={true}
            loader="Loading Results.."
            react={{
              and: ["PriceFilter", "SearchFilter"],
            }}
            // onData={this.onData}
          />
        </div>
      </ReactiveBase>
    );
  }
}

export default App;
