import React, { Component } from "react";
import {
  ReactiveBase,
  CategorySearch,
  SingleRange,
  ResultList
} from "@appbaseio/reactivesearch";
import "./App.css";

const ResultCard = (res: any) => {
  return {
    image: res.image,
    title: res.name,
    description: (
        <div>
            TEST
            <div className="price">${res.price}</div>
            <p>{res.room_type} · {res.accommodates} guests</p>
        </div>
    ),
    url: res.listing_url,
    containerProps: {
      onMouseEnter: () => console.log("😁"),
      onMouseLeave: () => console.log("🙀"),
    },
  };
};

const aggOptions = () => ({
  aggs: {
    min_date: {
      min: {
        field: "dateCreated"
      }
    },
    max_date: {
      max: {
        field: "dateCreated"
      }
    }
  }
}
);

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
            defaultValue={{
              term: "Politie",
            }}
            dataField={["text", "title"]}
            placeholder="Zoek in 109 gemeenten.."
            URLParams={true}
          />
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
            dataField="date_modified"
            stream={true}
            defaultQuery={aggOptions}
            sortBy="desc"
            size={8}
            pagination={false}
            showResultStats={true}
            loader="Loading Results.."
            react={{
              // When these components change, update the results
              and: ["ratingsfilter", "SearchFilter"],
            }}
            renderData={ResultCard}
          />
        </div>
      </ReactiveBase>
    );
  }
}

export default App;
