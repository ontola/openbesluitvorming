import * as React from "react";

import { typeToLabel } from "../../helpers";

interface DetailTypeProps {
  type: string;
}

const DetailType: React.FunctionComponent<DetailTypeProps> = (props) => {
  return (
    <div className="ResultCard__detail" >{typeToLabel(props.type)}</div>
  );
};
export default DetailType;
