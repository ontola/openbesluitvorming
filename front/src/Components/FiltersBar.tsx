import * as React from "react";
import { MultiList, RangeSlider } from "@appbaseio/reactivesearch";
import {
  allIdsBut,
  capitalize,
  ids,
  indexToLabel,
  typeToLabel,
} from "../helpers";
import Button from "./Button";
import { topTag } from "../types";
import FilterTitle from "./FilterTitle";

interface FiltersbarProps {
  display: boolean;
}

const startDate = new Date(2000, 1);
// Set endDate one year in the future - we might want to see meetings that haven't happened yet
const endDate = new Date(
  Date.now() + 1000 /*sec*/ * 60 /*min*/ * 60 /*hour*/ * 24 /*day*/ * 365,
);

const dateLabel = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`;

const MunicipalityLabel = (label: string, count: number) => {
  return (
    <span>
      <span>{indexToLabel(label)}</span>
      <span>{count}</span>
    </span>
  );
};

export const TypeLabel = (label: string, count: number) => (
  <span>
    <span>{typeToLabel(label)}</span>
    <span>{count}</span>
  </span>
);

export const DateToolTip = (data: string) => (
  <div
    style={{
      whiteSpace: "nowrap",
    }}
  >
    {dateLabel(new Date(data))}
  </div>
);

const Filtersbar: React.FunctionComponent<FiltersbarProps> = (props) => {
  const [showDateRange, setShowDateRange] = React.useState(false);
  // const [showMap, setShowMap] = React.useState(false);

  return (
    <div
      className={`FilterBar ${
        props.display ? "FilterBar__visible" : "FilterBar__hidden"
      }`}
    >
      {
        /* <MultiList
        title={
          <FilterTitle helper="Het type item, zoals Document of Vergadering.">
            Type
          </FilterTitle>
        }
        componentId={ids.type}
        dataField="@type"
        filterLabel="Type"
        className="Filter__item"
        size={500}
        sortBy="count"
        queryFormat="or"
        renderItem={TypeLabel}
        showCheckbox={false}
        showCount={true}
        showSearch={false}
        placeholder="Zoek type..."
        react={{
          and: allIdsBut(ids.type),
        }}
        showFilter={true}
        URLParams={true}
      /> */
      }
      {/* For now disable this #39 */}
      {
        /* {!showDateRange && <DateRange
        componentId={ids.daterange}
        dataField="last_discussed_at"
        className="Filter__item"
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
      />} */
      }
      <MultiList
        title={
          <FilterTitle helper="De organisatie waar het document vandaan komt.">
            Organisaties
          </FilterTitle>
        }
        componentId={ids.organisaties}
        dataField="_index"
        filterLabel={capitalize(ids.organisaties)}
        size={500}
        sortBy="count"
        queryFormat="or"
        showCheckbox={false}
        showCount={true}
        showSearch={true}
        placeholder="Zoek organisatie..."
        react={{
          and: allIdsBut(ids.organisaties),
        }}
        showFilter={true}
        URLParams={true}
        className="Filter__item"
        renderItem={MunicipalityLabel}
      />
      <MultiList
        title={
          <FilterTitle helper="Het thema dat wordt herkend in de tekst. Dit is automatisch gegenereerd.">
            Thema
          </FilterTitle>
        }
        componentId={ids.tag}
        // This selects the last theme, 9th item (there are 9 themes), which scores the lowest
        dataField={`tags.${topTag}.https://argu.co/ns/meeting/tag.keyword`}
        filterLabel={capitalize(ids.tag)}
        size={500}
        sortBy="count"
        queryFormat="or"
        showSearch={false}
        showCheckbox={false}
        showCount={true}
        react={{
          and: allIdsBut(ids.tag),
        }}
        showFilter={true}
        URLParams={true}
        className="Filter__item"
      />
      {
        /* <div className="Filter__item">
        <Button
          onClick={() => setShowMap(!showMap)}
          className={`Button__toggle ${
            showMap ? "Button__toggle-on" : "Button__toggle-off"
          }`}
          title={
            "Door het herkennen van straatnamen kunnen we items zoeken op de kaart. Mogelijk gemaakt door WaarOverheid.nl."
          }
        >
          <h3>{`${showMap ? "Sluit" : "Toon"} kaart`}</h3>
        </Button>
      </div> */
      }
      <div className="Filter__item">
        <Button
          onClick={() => setShowDateRange(!showDateRange)}
          className={`Button__toggle ${
            showDateRange ? "Button__toggle-on" : "Button__toggle-off"
          }`}
        >
          <h3>{`${showDateRange ? "Sluit" : "Toon"} datum filter`}</h3>
        </Button>
      </div>
      {showDateRange && (
        <RangeSlider
          componentId={ids.daterange}
          dataField="last_discussed_at"
          className="Filter__item"
          tooltipTrigger="hover"
          showHistogram={true}
          showFilter={true}
          renderTooltipData={DateToolTip}
          URLParams={true}
          queryFormat="date"
          rangeLabels={{
            start: dateLabel(startDate),
            end: dateLabel(endDate),
          }}
          range={{
            start: startDate.getTime(),
            end: endDate.getTime(),
          }}
          react={{
            and: allIdsBut(ids.daterange),
          }}
        />
      )}
    </div>
  );
};

export default Filtersbar;
