import * as React from "react";
import { ReactiveList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import ResultCard from "../Components/ResultCard";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSpinner } from "@fortawesome/free-solid-svg-icons";

interface ResultsListProps {
}

interface ResultsType {
  numberOfResults: number;
  numberOfPages: number;
  currentPage: number;
  time: number;
  displayedResults: number;
}

const ResultStats = (props: ResultsType) =>
  <div className="bottom-margin">
    {props.numberOfResults} resultaten gevonden
    in {props.time}ms
  </div>;

const NoResults = () =>
  <div>Geen resultaten gevonden.</div>;

const Loading = () =>
  <div className="Results__loader">
    <FontAwesomeIcon icon={faSpinner} spin />
    {" Laden.."}
  </div>;

// interface SortOption {
//   label: string;
//   dataField:any;
//   sortBy: string;
// }

// const sortOptions: SortOption[] = [
//   {
//     label: "datum",
//     dataField: "date_modified",
//     sortBy: "desc",
//   },
// ]

const ResultsList: React.FunctionComponent<ResultsListProps> = (props) => {
  return (
    <ReactiveList
      componentId="ResultList01"
      dataField="_score"
      stream={false}
      sortBy="desc"
      size={10}
      pagination={false}
      onNoResults={<NoResults/>}
      renderResultStats={props => <ResultStats {...props}/>}
      loader={<Loading/>}
      // sortOptions={sortOptions}
      renderError={(error: any) => (
        <div>
            Something went wrong!<br/>Error details<br/>{error}
        </div>
       )
      }
      react={{
        // When these components change, update the results
        and: allComponentIds,
      }}
      renderItem={props => <ResultCard {...props} />}
    />
  );
};

export default ResultsList;
