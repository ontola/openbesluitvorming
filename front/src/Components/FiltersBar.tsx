import * as React from "react";
import {
  DateRange,
  SelectedFilters,
  SingleList,
} from "@appbaseio/reactivesearch";
import { indexToMunicipality, typeToLabel } from "../helpers";

interface FiltersbarProps {
  display: boolean;
}

export const filterStyle = {
  marginBottom: "10px",
};

export const MunicipalityLabel = (label: string, count: number, isSelected: boolean) =>
  <span>
    <span>{indexToMunicipality(label)}</span>
    <span>{count}</span>
  </span>;

export const TypeLabel = (label: string, count: number, isSelected: boolean) =>
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
      <SingleList
        componentId="gemeente"
        dataField="_index"
        filterLabel="Gemeenten"
        size={100}
        sortBy="count"
        showRadio={false}
        showCount={true}
        showSearch={true}
        placeholder="Zoek gemeente..."
        showFilter={true}
        URLParams={true}
        style={filterStyle}
        className="Filter"
        loader="Loading ..."
        renderItem={MunicipalityLabel}
        renderError={(error: any) => <div>{JSON.stringify(error)}</div>}
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
  </div>
  );
};

export default Filtersbar;
