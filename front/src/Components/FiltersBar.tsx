import * as React from "react";
import {
  MultiList,
  RangeSlider,
} from "@appbaseio/reactivesearch";
import { indexToLabel, typeToLabel, ids, capitalize } from "../helpers";
import Button from './Button';

interface FiltersbarProps {
  display: boolean;
}

const startDate = new Date(2018, 1);

const dateLabel = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`

const MunicipalityLabel = (label: string, count: number) => {
  return (
    <span>
      <span>{indexToLabel(label)}</span>
      <span>{count}</span>
    </span>
  );
}

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
      <MultiList
        componentId={ids.type}
        dataField="@type.keyword"
        filterLabel="Type"
        title="Type"
        className="Filter"
        size={500}
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
            ids.organisaties,
          ],
        }}
        showFilter={true}
        URLParams={true}
      />
      <Button
        onClick={() => setShowDateRange(!showDateRange)}
        className={`Button__toggle ${showDateRange? "Button__toggle-on" : "Button__toggle-off"}`}
      >
        <h3>Datum filter</h3>
      </Button>
      {showDateRange && <RangeSlider
        componentId={ids.daterange}
        dataField="last_discussed_at"
        className="Filter"
        tooltipTrigger="hover"
        showHistogram={true}
        showFilter={true}
        renderTooltipData={DateToolTip}
        URLParams={true}
        rangeLabels={{
          "start": dateLabel(startDate),
          "end": dateLabel(new Date()),
        }}
        range={{
          "start": startDate.getTime(),
          "end": Date.now(),
        }}
        react={{
          and: [ids.searchbox, ids.organisaties, ids.type],
        }}
      />}
      {/* For now disable this #39 */}
      {/* {!showDateRange && <DateRange
        componentId={ids.daterange}
        dataField="last_discussed_at"
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
      />} */}
      <MultiList
        componentId={ids.organisaties}
        dataField="_index"
        title={capitalize(ids.organisaties)}
        filterLabel={capitalize(ids.organisaties)}
        size={500}
        sortBy="count"
        queryFormat="or"
        showCheckbox={false}
        showCount={true}
        showSearch={true}
        placeholder="Zoek organisatie..."
        react={{
          and: [ids.searchbox, ids.daterange, ids.type],
        }}
        showFilter={true}
        URLParams={true}
        className="Filter"
        renderItem={MunicipalityLabel}
      />
    </div>
  );
};

export default Filtersbar;
