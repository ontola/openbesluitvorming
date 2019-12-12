import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToLabel } from "../../helpers";
import DetailType from "../Details/DetailType";

interface MeetingProps extends ORIItemType {
  committee?: string;
  description?: string;
  end_date?: string;
  organization?: string;
  start_date?: string;
  status?: string;
}

const Meeting: React.FunctionComponent<MeetingProps> = (props) => {
  let date = null;
  if (props.start_date !== undefined) {
    date = new Date(props.start_date);
  }

  return (
    <React.Fragment>
      {props.highlight.text && props.highlight.text.map(
        ((text: string) => (
          <div key={text} className="ResultCard__highlight">
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
          </div>
        )))
      }
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToLabel(props._index)}</div>
        <DetailType type={props["@type"]} />
        {date &&
          <div className="ResultCard__detail" >{date.toLocaleDateString("nl-NL")}</div>
        }
      </div>
      {props.description &&
        <p dangerouslySetInnerHTML={{ __html: `${props.description}...` }}/>
      }
    </React.Fragment>
  );
};
export default Meeting;
