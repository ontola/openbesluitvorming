import * as React from "react";

import { ORIItemType } from "../types.ts";
import { getParams, useOpenResource } from "../helpers.ts";
import Document from "./Cards/Document.tsx";
// import Meeting from "./Cards/Meeting";
// import AgendaItem from "./Cards/AgendaItem";
// import CreativeWork from "./Cards/CreativeWork";
// import Organization from "./Cards/Organization";
// import Person from "./Cards/Person";
import Button from "./Button.tsx";

interface ResultCardProps extends ORIItemType {
  label?: string;
  title?: string;
}

const renderComponent = (props: ORIItemType) => {
  switch (props["@type"]) {
    case "MediaObject":
      // We should only see MediaObjects in the search results now!
      return <Document {...props} />;
  }
};

const ResultCard: React.FunctionComponent<ResultCardProps> = (props) => {
  const { currentResource } = getParams();

  const className = `ResultCard ${
    props["@id"] && currentResource === props["@id"] ? "ResultCard--active" : ""
  }`;

  const openResource = useOpenResource();

  const header = props.name || props.label || props.title || "Geen naam";
  return (
    <div key={props["@id"]} className={className}>
      <Button
        onClick={() => {
          openResource(props["original_url"] || "");
        }}
      >
        {/* This is not ideal - it makes injection possible in ORI data, bu */}
        <h2 dangerouslySetInnerHTML={{ __html: `${header}` }} />
      </Button>
      {renderComponent(props)}
    </div>
  );
};
export default ResultCard;
