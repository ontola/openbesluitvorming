import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import DetailType from "../Details/DetailType";
import DetailJSON from "../Details/DetailJSON";

interface CreativeWorkProps extends ORIItemType {
  classification?: string;
  parent?: string;
}

const CreativeWork: React.FunctionComponent<CreativeWorkProps> = (props) => {
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
      </div>
      <p>Classification: {props.classification}</p>
    </React.Fragment>
  );
};

export default CreativeWork;
