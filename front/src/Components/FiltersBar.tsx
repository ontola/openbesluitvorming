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

const filterStyle = {
  marginBottom: "10px",
};

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
        className="Filter"
        loader="Loading ..."
        renderItem={MunicipalityLabel}
      />
      <MultiList
        componentId="type"
        dataField="_type"
        filterLabel="Type"
        title="Type"
        className="Filter"
        size={100}
        sortBy="count"
        queryFormat="or"
        renderItem={TypeLabel}
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
