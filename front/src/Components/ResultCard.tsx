import * as React from "react";

import { ORIItemType } from "../types";
import { RouteComponentProps, withRouter } from "react-router";
import { getParams } from "../helpers";
import Document from "./Cards/Document";
import Meeting from "./Cards/Meeting";
import AgendaItem from "./Cards/AgendaItem";
import CreativeWork from "./Cards/CreativeWork";
import Organization from "./Cards/Organization";
import Person from "./Cards/Person";

interface ResultCardProps extends ORIItemType {
}

const renderComponent = (props: ORIItemType) => {
  switch (props._type) {
    case "media_object":
      return <Document {...props} />;
    case "meeting":
      return <Meeting {...props} />;
    case "agenda_item":
      return <AgendaItem {...props} />;
    case "creative_work":
      return <CreativeWork {...props} />;
    case "organization":
      return <Organization {...props} />;
    case "person":
      return <Person {...props} />;
    default:
      return <p>No component</p>;
  }
};

const ResultCard: React.FunctionComponent<ResultCardProps & RouteComponentProps> = (props) => {
  const {
    currentDocument,
  } = getParams(props.history);
  const className = `ResultCard ${
    (props.original_url && (currentDocument === props.original_url))
    ? "ResultCard--active" : null }`;
  return (
    <div key={props._id} className={className}>
      {renderComponent(props)}
    </div>
  );
};
export default withRouter(ResultCard);
