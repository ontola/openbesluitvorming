import * as React from "react";
import {
  DateRange,
  MultiList,
  SelectedFilters,
} from "@appbaseio/reactivesearch";

interface FiltersbarProps {
}

const filterStyle = {
  marginBottom: "10px",
};

const Filtersbar: React.FunctionComponent<FiltersbarProps> = (props) => {
  return (
    <div className="FilterBar">
      <SelectedFilters
        clearAllLabel="Filters wissen"
      />
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
        style={filterStyle}
      />
      <MultiList
        componentId="gemeenten"
        dataField="_index"
        title="Gemeenten"
        filterLabel="Gemeenten"
        size={100}
        sortBy="count"
        queryFormat="or"
        showCheckbox={true}
        showCount={true}
        showSearch={true}
        placeholder="Zoek gemeente..."
        react={{
          and: ["searchbox", "daterange", "type"],
        }}
        showFilter={true}
        URLParams={true}
        style={filterStyle}
        className={"Filter"}
        loader="Loading ..."
      />
      <MultiList
        componentId="type"
        dataField="_type"
        filterLabel="Type"
        title="Type"
        size={100}
        sortBy="count"
        queryFormat="or"
        showCheckbox={true}
        showCount={true}
        showSearch={false}
        placeholder="Zoek type..."
        react={{
          and: ["searchbox", "daterange", "daterange", "gemeenten"],
        }}
        showFilter={true}
        style={filterStyle}
        URLParams={true}
        loader="Loading ..."
      />
  </div>
  );
};

export default Filtersbar;
