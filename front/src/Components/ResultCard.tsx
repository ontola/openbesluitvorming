import * as React from "react";

import { ORIItemType } from "../types";
import { withRouter, RouteComponentProps } from "react-router";
import { History } from "history";
import { getParams } from "../helpers";
import Button from "./Button";

interface ResultCardProps extends ORIItemType {
}

const openDocument = (url :string, history: History) => {
  const currentURL = new URL(window.location.href);
  currentURL.searchParams.set("showDocument", encodeURIComponent(url));
  history.push(currentURL.toString().substring(currentURL.origin.length));
};

const ResultCard: React.FunctionComponent<ResultCardProps & RouteComponentProps> = (props) => {
  const {
    currentDocument,
  } = getParams(props.history);
  const date = new Date(props.date_modified);
  // Turns ori_amsteram_215970157 into Amsterdam
  const parts = props._index.split("_");
  const municipality = parts
    .slice(1, parts.length - 1)
    .map(s => `${s.charAt(0).toLocaleUpperCase()}${s.substring(1)}`)
    .join(" ");
  const className = `ResultCard ${
    (currentDocument === props.original_url) ? "ResultCard--active" : null }`;
  return (
    <div key={props._id} className={className}>
      <Button
        onClick={() => openDocument(props.original_url, props.history)}
      >
        <h2>
          {props.name}
        </h2>
      </Button>
      {props.highlight.text && props.highlight.text.map(
        ((text: string) => (
          <div key={text}>
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
          </div>
        )))
      }
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{municipality}</div>
        <a className="ResultCard__detail" href={props.original_url}>download</a>
        <div className="ResultCard__detail" >{props._type}</div>
        <div className="ResultCard__detail" >{props.content_type}</div>
        <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
      </div>
    </div>
  );
};
export default withRouter(ResultCard);
