import * as React from "react";

import { ORIItemType } from "../types";

interface ResultCardProps extends ORIItemType {
}

const ResultCard: React.FunctionComponent<ResultCardProps> = (props) => {
  const date = new Date(props.date_modified);
  return (
    <div key={props._id} className="ResultCard">
      <h2>{props.name}</h2>
      {props.highlight.text && props.highlight.text.map(
        ((text: string) => (
          <div key={text}>
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
          </div>
        )))
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
