import * as React from "react";
import { RouteComponentProps, withRouter } from "react-router";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import DetailType from "../Details/DetailType";
import Button from "../Button";
import { History } from "history";

interface DocumentProps extends ORIItemType {
  content_type?: string;
  date_modified?: string;
  original_url?: string;
  size_in_bytes?: string;
  text?: string;
  url?: string;
}

const Document: React.FunctionComponent<DocumentProps & RouteComponentProps> = (props) => {

  let date = null;
  if (props.date_modified !== undefined) {
    date = new Date(props.date_modified);
  }

  const openDocument = (url :string, history: History) => {
    const currentURL = new URL(window.location.href);
    currentURL.searchParams.set("showDocument", encodeURIComponent(url));
    history.push(currentURL.toString().substring(currentURL.origin.length));
  };

  return (
    <React.Fragment>
      <Button
        onClick={() => openDocument((props.original_url || ""), props.history)}
      >
        <h2 dangerouslySetInnerHTML={{ __html: `${props.name}` }}/>
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
        <DetailType type={props._type} />
        {props.content_type &&
          <div className="ResultCard__detail" >{props.content_type}</div>
        }
        {date &&
          <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
        }
        {props.original_url &&
          <a className="ResultCard__detail" href={props.original_url} title="Download bestand">
            <FontAwesomeIcon icon={faDownload}/>
          </a>
        }
      </div>
    </React.Fragment>
  );
};
export default withRouter(Document);
