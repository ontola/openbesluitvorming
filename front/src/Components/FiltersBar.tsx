import * as React from "react";
import {
  DateRange,
  MultiList,
  RangeSlider,
  SelectedFilters,
} from "@appbaseio/reactivesearch";
import { indexToMunicipality, typeToLabel, ids, capitalize } from "../helpers";
import { LoadingWithSpinner } from "./ResultsList";
import Button from './Button';

interface FiltersbarProps {
  display: boolean;
}

const startDate = new Date(2018, 1);

const dateLabel = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`

const MunicipalityLabel = (label: string, count: number) =>
  <span>
    <span>{indexToMunicipality(label)}</span>
    <span>{count}</span>
  </span>;

export const TypeLabel = (label: string, count: number) =>
  <span>
    <span>{typeToLabel(label)}</span>
    <span>{count}</span>
  </span>;

export const DateToolTip = (data: string) =>
  <div
    style={{
      whiteSpace: "nowrap",
    }}
  >{dateLabel(new Date(data))}</div>

const Filtersbar: React.FunctionComponent<FiltersbarProps> = (props) => {

  const [showDateRange, setShowDateRange] = React.useState(false);

  return (
    <div
      className={`FilterBar ${props.display ? "FilterBar__visible" : "FilterBar__hidden"}`}
    >
      <SelectedFilters
        showClearAll={false}
        className="Filter Filter__current"
      />
      <MultiList
        componentId={ids.type}
        dataField="@type.keyword"
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
          and: [
            ids.searchbox,
            ids.daterange,
            ids.gemeenten,
          ],
        }}
        showFilter={true}
        URLParams={true}
        loader={<LoadingWithSpinner/>}
      />
      <Button
        onClick={() => setShowDateRange(!showDateRange)}
      >{showDateRange ? "Velden tonen" : "Histogram tonen" }</Button>
      {showDateRange && <RangeSlider
        componentId={ids.daterange}
        dataField="date_modified"
        title="Datum"
        className="Filter"
        tooltipTrigger="hover"
        renderTooltipData={DateToolTip}
        URLParams={true}
        rangeLabels={{
          "start": dateLabel(startDate),
          "end": dateLabel(new Date),
        }}
        range={{
          "start": startDate.getTime(),
          "end": Date.now(),
        }}
      />}
      {!showDateRange && <DateRange
        componentId={ids.daterange}
        dataField="date_modified"
        className="Filter"
        title={capitalize(ids.daterange)}
        placeholder={{
          start: "Van...",
          end: "Tot...",
        }}
        numberOfMonths={2}
        queryFormat="date"
        autoFocusEnd={false}
        showClear={false}
        showFilter={true}
        filterLabel={capitalize(ids.daterange)}
        URLParams={true}
      />}
      <MultiList
        componentId={ids.gemeenten}
        dataField="_index"
        title={capitalize(ids.gemeenten)}
        filterLabel={capitalize(ids.gemeenten)}
        size={100}
        sortBy="count"
        queryFormat="or"
        showCheckbox={false}
        showCount={true}
        showSearch={true}
        placeholder="Zoek gemeente..."
        react={{
          and: [ids.searchbox, ids.daterange, ids.type],
        }}
        showFilter={true}
        URLParams={true}
        className="Filter"
        loader={<LoadingWithSpinner/>}
        renderItem={MunicipalityLabel}
      />
    </div>
  );
};

export default Filtersbar;
