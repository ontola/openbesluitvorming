import * as React from "react";

import { ORIItemType } from "../types";
import { RouteComponentProps, withRouter } from "react-router";
import { getParams, openResource } from "../helpers";
import paths from "../paths";
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

const ResultCard: React.FunctionComponent<
  ResultCardProps & RouteComponentProps
> = (props) => {
  const { currentResource } = getParams(props.history);

  const className = `ResultCard ${
    props["@id"] && currentResource === props["@id"] ? "ResultCard--active" : ""
  }`;

  const header = props.name || props.label || props.title || "Geen naam";
  return (
    <div key={props["@id"]} className={className}>
      <Button
        onClick={() => {
          openResource(props["original_url"] || "", props.history);
        }}
      >
        {/* This is not ideal - it makes injection possible in ORI data, bu */}
        <h2 dangerouslySetInnerHTML={{ __html: `${header}` }} />
      </Button>
      {renderComponent(props)}
    </div>
  );
};
export default withRouter(ResultCard);
