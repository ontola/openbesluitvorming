import * as React from "react";
import { ResultList } from "@appbaseio/reactivesearch";

import { allComponentIds } from "../helpers";
import { ORIItemType } from "../types";

interface ResultsListProps {
}

const NoResults = () =>
  <p>no results</p>;

const ResultCard = (res: ORIItemType) => {
  const date = new Date(res.date_modified);
  return {
    title: res.name,
    description: (
      <div>
        <p>{date.toLocaleDateString()}</p>
        <p>{res._type}</p>
        <p>{res._index}</p>
        <p>{res.content_type}</p>
        <p><span dangerouslySetInnerHTML={{ __html: res.highlight.text }}/></p>
      </div>
    ),
    url: res.original_url,
  };
};

const ResultsList: React.FunctionComponent<ResultsListProps> = (props) => {
  return (
    <ResultList
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
