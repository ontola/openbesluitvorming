import * as React from "react";
import { ReactiveList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import ResultCard from "../Components/ResultCard";

interface ResultsListProps {
}

const NoResults = () =>
  <p>no results</p>;

const ResultsList: React.FunctionComponent<ResultsListProps> = (props) => {
  return (
    <ReactiveList
      componentId="ResultList01"
      dataField="date_modified"
      stream={true}
      sortBy="desc"
      size={20}
      pagination={false}
      showResultStats={true}
      onNoResults={NoResults}
      loader="Loading Results.."
      react={{
        // When these components change, update the results
        and: allComponentIds,
      }}
      renderData={ResultCard}
    />
  );
};

export default ResultsList;
