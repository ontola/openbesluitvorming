import * as React from "react";
import {
  DateRange,
  MultiList,
  SelectedFilters,
} from "@appbaseio/reactivesearch";

interface FiltersbarProps {
}

const Filtersbar: React.FunctionComponent<FiltersbarProps> = (props) => {
  return (
    <div>
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
  </div>
  );
};

export default Filtersbar;
