import * as React from "react";

import { ORIItemType } from "../types";

interface ResultCardProps extends ORIItemType {
}

const ResultCard: React.FunctionComponent<ResultCardProps> = (props) => {
  const date = new Date(props.date_modified);
  return (
    <div className="ResultCard">
      <h2>{props.name}</h2>
      {console.log(props.highlight)}
      {props.highlight.text && (
        <div>
          <span dangerouslySetInnerHTML={{ __html: props.highlight.text }}/>
        </div>
      )
      }
      <div className="ResultCard__details">
        <a className="ResultCard__detail" href={props.original_url}>download</a>
        <div className="ResultCard__detail" >{props._type}</div>
        <div className="ResultCard__detail" >{props._index}</div>
        <div className="ResultCard__detail" >{props.content_type}</div>
        <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
      </div>
    </div>
  );
};
export default ResultCard;
