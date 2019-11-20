import * as React from "react";
import {
  MultiList,
  RangeSlider,
} from "@appbaseio/reactivesearch";
import { indexToLabel, typeToLabel, ids, capitalize } from "../helpers";
import Button from './Button';
import { topTag } from "../types";
import MapFilter from "./MapFilter";

interface FiltersbarProps {
  display: boolean;
}

const startDate = new Date(2000, 1);

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
      <MapFilter />
      <MultiList
        componentId={ids.type}
        dataField="@type.keyword"
        filterLabel="Type"
        title="Type"
        className="SidebarFilter"
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
            ids.tags,
          ],
        }}
        showFilter={true}
        URLParams={true}
      />
      <div className="SidebarFilter">
        <Button
          onClick={() => setShowDateRange(!showDateRange)}
          className={`Button__toggle ${showDateRange ? "Button__toggle-on" : "Button__toggle-off"}`}
        >
          <h3>Datum filter</h3>
        </Button>
      </div>
      {showDateRange && <RangeSlider
        componentId={ids.daterange}
        dataField="last_discussed_at"
        className="SidebarFilter"
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
          and: [
            ids.searchbox,
            ids.organisaties,
            ids.type,
            ids.tags
          ],
        }}
      />}
      {/* For now disable this #39 */}
      {/* {!showDateRange && <DateRange
        componentId={ids.daterange}
        dataField="last_discussed_at"
        className="SidebarFilter"
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
          and: [ids.searchbox, ids.daterange, ids.type, ids.tags],
        }}
        showFilter={true}
        URLParams={true}
        className="SidebarFilter"
        renderItem={MunicipalityLabel}
      />
      <MultiList
        componentId={ids.tags}
        // This selects the last theme, 9th item (there are 9 themes), which scores the lowest
        dataField={`tags.${topTag}.https://argu.co/ns/meeting/tag.keyword`}
        title={capitalize(ids.tags)}
        filterLabel={capitalize(ids.tags)}
        size={500}
        sortBy="count"
        queryFormat="or"
        showSearch={false}
        showCheckbox={false}
        showCount={true}
        react={{
          and: [
            ids.searchbox,
            ids.daterange,
            ids.type,
            ids.organisaties
          ],
        }}
        showFilter={true}
        URLParams={true}
        className="SidebarFilter"
      />
    </div>
  );
};

export default Filtersbar;
