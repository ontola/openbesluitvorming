import * as React from "react";
import { ORIItemType } from "../../types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCode } from "@fortawesome/free-solid-svg-icons";

const SpacingLevelJSON = 2;

const DetailJSON: React.FunctionComponent<ORIItemType> = (props) => {
  return (
    <a
      className="ResultCard__detail"
      href={`data:application/json;charset=utf-8,${encodeURIComponent(
        JSON.stringify(props, null, SpacingLevelJSON)
      )}`}
      download={`${props["@id"]}.json`}
      // eslint-disable-next-line
      target="_blank"
      rel="noopener noreferrer"
      title="Download JSON"
    >
      <FontAwesomeIcon icon={faCode} />
    </a>
  );
};
export default DetailJSON;
