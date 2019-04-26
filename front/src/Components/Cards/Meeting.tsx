import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import DetailType from "../Details/DetailType";
import DetailJSON from "../Details/DetailJSON";

interface MeetingProps extends ORIItemType {
  committee?: string;
  description?: string;
  end_date?: string;
  organization?: string;
  ori_identifier?: string;
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
      <h2 dangerouslySetInnerHTML={{ __html: `${props.name}` }}/>
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
        <DetailJSON {...props} />
        {date &&
          <div className="ResultCard__detail" >{date.toLocaleDateString()}</div>
        }
      </div>
      <p>{props.description}</p>
      <p>Commissie: {props.committee}</p>
      <p>Status: {props.status}</p>
    </React.Fragment>
  );
};
export default Meeting;
