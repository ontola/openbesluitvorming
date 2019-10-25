import * as React from "react";
import { ReactiveList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import ResultCard from "../Components/ResultCard";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSpinner } from "@fortawesome/free-solid-svg-icons";
import { handle, printAndHandle } from "../helpers/logging";

interface ResultsType {
  numberOfResults: number;
  numberOfPages: number;
  currentPage: number;
  time: number;
  displayedResults: number;
}

const ResultStats = (props: ResultsType) =>
  <div className="bottom-margin">
    {(props.numberOfResults === 10000) ? "meer dan 10.000" : props.numberOfResults}
    {" resultaten gevonden"}
  </div>;

const NoResults = () =>
  <div>Geen resultaten gevonden.</div>;

export const LoadingWithSpinner = () =>
  <div className="Results__loader">
    <FontAwesomeIcon icon={faSpinner} spin />
    <span>
      {" Laden..."}
    </span>
  </div>;

const DualLoader = () =>
  <div className="Results__dual-loader">
    <div className="Results__dual-loader-top">
      <LoadingWithSpinner/>
    </div>
    <div className="Results__dual-loader-bottom">
      <LoadingWithSpinner/>
    </div>
  </div>;

interface SortOption {
  label: string;
  dataField: any;
  sortBy: string;
}

export const sortOptions: SortOption[] = [
  {
    label: "Meest relevant",
    dataField: "_score",
    sortBy: "desc",
  },
  {
    label: "Nieuwste",
    dataField: "last_discussed_at",
    sortBy: "desc",
  },
];

const ResultsList: React.FunctionComponent = () => {
  return (
    <ReactiveList
      componentId="ResultList01"
      dataField="_score"
      stream={false}
      sortBy="desc"
      size={20}
      pagination={false}
      onNoResults={<NoResults/>}
      renderResultStats={props => <ResultStats {...props}/>}
      loader={<DualLoader/>}
      sortOptions={sortOptions}
      renderError={(error: Error) => {
        handle(error);
        return (
          <div>
            Something went wrong!<br/>
            {printAndHandle(error)}
          </div>
        );
      }}
      react={{
        // When these components change, update the results
        and: allComponentIds,
      }}
      renderItem={props => <ResultCard key={props['@id']} {...props} />}
    />
  );
};

export default ResultsList;
