import * as React from "react";

import { ORIItemType } from "../types";

interface ResultCardProps extends ORIItemType {
}

const ResultCard: React.FunctionComponent<ResultCardProps> = (props) => {
  const date = new Date(props.date_modified);
  return (
    <div className="ResultCard">
      <h2>{props.name}</h2>
      <p><span dangerouslySetInnerHTML={{ __html: props.highlight.text }}/></p>
      <div className="ResultCard__details">
        <a className="ResultCard__detail" href={props.original_url}>download</a>
        <p className="ResultCard__detail" >{props._type}</p>
        <p className="ResultCard__detail" >{props._index}</p>
        <p className="ResultCard__detail" >{props.content_type}</p>
        <p className="ResultCard__detail" >{date.toLocaleDateString()}</p>
      </div>
    </div>
  );
};
export default ResultCard;
