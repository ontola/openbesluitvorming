import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToLabel } from "../../helpers";
import DetailType from "../Details/DetailType";

interface OrgProps extends ORIItemType {
  classification?: string;
  name?: string;
  parent?: string;
}

const Organization: React.FunctionComponent<OrgProps> = (props) => {
  return (
    <React.Fragment>
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToLabel(props._index)}</div>
        <DetailType type={props["@type"]} />
      </div>
      {props.classification &&
        <p>Soort: {props.classification}</p>
      }
    </React.Fragment>
  );
};
export default Organization;
