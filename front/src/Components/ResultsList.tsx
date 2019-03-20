import * as React from "react";
import { ReactiveList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import ResultCard from "../Components/ResultCard";

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
  <div>no results</div>;

const Loading = () =>
  <div>Loading...</div>;

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
      onNoResults={<NoResults/>}
      onResultStats={ResultStats}
      loader={<Loading/>}
      react={{
        // When these components change, update the results
        and: allComponentIds,
      }}
      renderData={props => <ResultCard {...props} />}
    />
  );
};

export default ResultsList;
