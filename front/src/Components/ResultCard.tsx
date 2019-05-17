import * as React from "react";

import { ORIItemType } from "../types";
import { RouteComponentProps, withRouter } from "react-router";
import { getParams, openResource } from "../helpers";
import Document from "./Cards/Document";
import Meeting from "./Cards/Meeting";
import AgendaItem from "./Cards/AgendaItem";
import CreativeWork from "./Cards/CreativeWork";
import Organization from "./Cards/Organization";
import Person from "./Cards/Person";
import Button from "./Button";

interface ResultCardProps extends ORIItemType {
  label?: string;
  title?: string;
}

const renderComponent = (props: ORIItemType) => {
  switch (props["@type"]) {
    case "MediaObject":
      return <Document {...props} />;
    case "Meeting":
      return <Meeting {...props} />;
    case "AgendaItem":
      return <AgendaItem {...props} />;
    case "CreativeWork":
      return <CreativeWork {...props} />;
    case "Organization":
      return <Organization {...props} />;
    case "Person":
      return <Person {...props} />;
    default:
      return <p>No component for type {[props["@type"]]}</p>;
  }
};

const ResultCard: React.FunctionComponent<ResultCardProps & RouteComponentProps> = (props) => {
  const {
    currentResource,
  } = getParams(props.history);
  const className = `ResultCard ${
    (props.original_url && (currentResource === props.ori_identifier))
    ? "ResultCard--active" : null }`;

  const header = props.name || props.label || props.title || "";
  return (
    <div key={props._id} className={className}>
      <Button
        onClick={() => openResource((props.ori_identifier || ""), props.history)}
      >
        <h2 dangerouslySetInnerHTML={{ __html: `${header}` }}/>
      </Button>
      {renderComponent(props)}
    </div>
  );
};
export default withRouter(ResultCard);
