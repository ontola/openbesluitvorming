import * as React from "react";
import { ORIItemType } from "../../types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCode } from "@fortawesome/free-solid-svg-icons";

interface DetailJSONProps extends ORIItemType {
}

const SpacingLevelJSON = 2;

const DetailJSON: React.FunctionComponent<DetailJSONProps> = (props) => {
  return (
    <a
      className="ResultCard__detail"
      href={`data:application/json;charset=utf-8,${
        encodeURIComponent(JSON.stringify(props, null, SpacingLevelJSON))
      }`}
      download={`${props._id}.json`}
      target="_blank"
      title="Download JSON"
    >
      <FontAwesomeIcon icon={faCode}/>
    </a>
  );
};
export default DetailJSON;
