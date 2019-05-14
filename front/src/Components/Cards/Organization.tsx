import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import DetailType from "../Details/DetailType";
import DetailJSON from "../Details/DetailJSON";

interface OrgProps extends ORIItemType {
  classification?: string;
  name?: string;
  parent?: string;
}

const Organization: React.FunctionComponent<OrgProps> = (props) => {
  return (
    <React.Fragment>
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToMunicipality(props._index)}</div>
        <DetailType type={props["@type"]} />
        <DetailJSON {...props} />
      </div>
      <p>Classification: {props.classification}</p>
      <p>Parent: {props.parent}</p>
    </React.Fragment>
  );
};
export default Organization;
