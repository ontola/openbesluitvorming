import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToLabel } from "../../helpers";
import DetailType from "../Details/DetailType";

interface CreativeWorkProps extends ORIItemType {
  classification?: string;
  parent?: string;
}

const CreativeWork: React.FunctionComponent<CreativeWorkProps> = (props) => {
  return (
    <React.Fragment>
      {props.highlight.text && props.highlight.text.map(
        (text: string) => (
          <div key={text} className="ResultCard__highlight">
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }} />
          </div>
        ),
      )}
      <div className="ResultCard__details">
        <div className="ResultCard__detail">{indexToLabel(props._index)}</div>
        <DetailType type={props["@type"]} />
      </div>
    </React.Fragment>
  );
};

export default CreativeWork;
