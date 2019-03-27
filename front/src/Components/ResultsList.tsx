import * as React from "react";
import { ReactiveList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import ResultCard from "../Components/ResultCard";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSpinner } from "@fortawesome/free-solid-svg-icons";
// import { string, any } from "prop-types";

interface ResultsListProps {
}

interface ResultsType {
  total_results: number;
}

const ResultStats = ({
  total_results,
}: ResultsType) =>
  <div>{total_results}</div>;

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
      dataField="date_modified"
      stream={false}
      sortBy="desc"
      size={10}
      pagination={false}
      onNoResults={<NoResults/>}
      onResultStats={props => <ResultStats {...props}/>}
      loader={<Loading/>}
      // sortOptions={sortOptions}
      react={{
        // When these components change, update the results
        and: allComponentIds,
      }}
      renderData={props => <ResultCard {...props} />}
    />
  );
};

export default ResultsList;
