import * as React from "react";
import { RouteComponentProps, withRouter } from "react-router";

import { ORIItemType } from "../../types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import DetailType from "../Details/DetailType";

import { indexToLabel } from "../../helpers";
import Tags from '../Tags';

interface DocumentProps extends ORIItemType {
  content_type?: string;
  last_discussed_at?: string;
  original_url?: string;
  size_in_bytes?: string;
  text?: string;
  url?: string;
}

const Document: React.FunctionComponent<DocumentProps & RouteComponentProps> = (props) => {

  let date = null;
  if (props.last_discussed_at !== undefined) {
    date = new Date(props.last_discussed_at);
  }

  return (
    <React.Fragment key={props["@id"]}>
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToLabel(props._index)}</div>
        <DetailType type={props["@type"]} />
        {date &&
          <div className="ResultCard__detail" >{date.toLocaleDateString("nl-NL")}</div>
        }
        {props.original_url &&
          <a className="ResultCard__detail" href={props.original_url} title="Download bestand">
            <FontAwesomeIcon icon={faDownload}/>
          </a>
        }
      </div>
      <Tags tags={props.tags}/>
      {props.highlight.text &&
        <div className="ResultCard__highlights">
          {props.highlight.text.map(
            ((text: string) => (
              <div key={text} className="ResultCard__highlight">
                <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
              </div>
            )))
          }
        </div>
      }
    </React.Fragment>
  );
};

const hoc = (Comp: any) => {
  return function DocumentWithProps (props: DocumentProps) {
    return (
      <React.Fragment key={props["@id"]}>
        <Comp {...props} />
      </React.Fragment>
    );
  };
};

export default hoc(withRouter(Document));
