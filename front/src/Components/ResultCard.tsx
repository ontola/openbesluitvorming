import * as React from "react";

import { ORIItemType } from "../types";
import { withRouter, RouteComponentProps } from "react-router";
import { History } from "history";
import { getParams, indexToMunicipality, typeToLabel } from "../helpers";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";

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
          <div key={text} className="ResultCard__highlight">
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
          </div>
        )))
      }
      <div className="ResultCard__details">
      <div className="ResultCard__detail" >{indexToMunicipality(props._index)}</div>
        <div className="ResultCard__detail" >{typeToLabel(props._type)}</div>
        {props.content_type &&
          <div className="ResultCard__detail" >{props.content_type}</div>
        }
        {props.date_modified &&
          <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
        }
        {props.original_url &&
          <a className="ResultCard__detail" href={props.original_url} title="Download bestand">
            <FontAwesomeIcon icon={faDownload}/>
          </a>
        }
      </div>
    </div>
  );
};
export default withRouter(ResultCard);
