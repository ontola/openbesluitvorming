import * as React from "react";

import { ORIItemType } from "../../types";
import { indexToMunicipality } from "../../helpers";
import DetailType from "../Details/DetailType";

interface OrgProps extends ORIItemType {
  classification?: string;
  name?: string;
  parent?: string;
}

const Organization: React.FunctionComponent<OrgProps> = (props) => {
  return (
    <React.Fragment>
      <h2 dangerouslySetInnerHTML={{ __html: `${props.name}` }}/>
      <div className="ResultCard__details">
        <div className="ResultCard__detail" >{indexToMunicipality(props._index)}</div>
        <DetailType type={props._type} />
      </div>
      <p>Classification: {props.classification}</p>
      <p>Parent: {props.parent}</p>
    </React.Fragment>
  );
};
export default Organization;
