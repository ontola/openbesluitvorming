import * as React from "react";
import {
  DateRange,
  MultiList,
  SelectedFilters,
} from "@appbaseio/reactivesearch";
import { indexToMunicipality, typeToLabel } from "../helpers";

interface FiltersbarProps {
  display: boolean;
}

const MunicipalityLabel = (label: string, count: number, isSelected: boolean) =>
  <span>
    <span>{indexToMunicipality(label)}</span>
    <span>{count}</span>
  </span>;

const TypeLabel = (label: string, count: number, isSelected: boolean) =>
  <span>
    <span>{typeToLabel(label)}</span>
    <span>{count}</span>
  </span>;

const Filtersbar: React.FunctionComponent<FiltersbarProps> = (props) => {
  return (
    <div
      className={`FilterBar ${props.display ? "FilterBar__visible" : "FilterBar__hidden"}`}
    >
      <SelectedFilters
        showClearAll={false}
        className="Filter Filter__current"
      />
      <DateRange
        componentId="daterange"
        dataField="date_modified"
        className="Filter"
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
        filterLabel="Gemeenten"
        size={100}
        sortBy="count"
        queryFormat="or"
        showCheckbox={false}
        showCount={true}
        showSearch={true}
        placeholder="Zoek gemeente..."
        react={{
          and: ["searchbox", "daterange", "type"],
        }}
        showFilter={true}
        URLParams={true}
        className="Filter"
        loader="Loading ..."
        renderItem={MunicipalityLabel}
      />
      <MultiList
        componentId="type"
        dataField="@type"
        filterLabel="Type"
        title="Type"
        className="Filter"
        size={100}
        sortBy="count"
        queryFormat="or"
        renderItem={TypeLabel}
        showCheckbox={false}
        showCount={true}
        showSearch={false}
        placeholder="Zoek type..."
        react={{
          and: ["searchbox", "daterange", "daterange", "gemeenten"],
        }}
        showFilter={true}
        URLParams={true}
        loader="Loading ..."
      />
  </div>
  );
};

export default Filtersbar;
