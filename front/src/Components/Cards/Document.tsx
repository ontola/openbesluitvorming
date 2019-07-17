import * as React from "react";
import { RouteComponentProps, withRouter } from "react-router";

import { ORIItemType } from "../../types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import DetailType from "../Details/DetailType";

import { indexToMunicipality } from "../../helpers";

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

  return (
    <React.Fragment key={props._id}>
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToMunicipality(props._index)}</div>
        <DetailType type={props["@type"]} />
        {date &&
          <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
        }
        {props.original_url &&
          <a className="ResultCard__detail" href={props.original_url} title="Download bestand">
            <FontAwesomeIcon icon={faDownload}/>
          </a>
        }
      </div>
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
      <React.Fragment key={props._id}>
        <Comp {...props} />
      </React.Fragment>
    );
  };
};

export default hoc(withRouter(Document));
