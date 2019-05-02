import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import DetailType from "../Details/DetailType";
import DetailJSON from "../Details/DetailJSON";

interface MeetingProps extends ORIItemType {
  email?: string;
  gender?: string;
}

const Meeting: React.FunctionComponent<MeetingProps> = (props) => {
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
        <DetailType type={props["@type"]} />
        <DetailJSON {...props} />
      </div>
      <p>Email: {props.email}</p>
      <p>Gender: {props.gender}</p>
    </React.Fragment>
  );
};
export default Meeting;
