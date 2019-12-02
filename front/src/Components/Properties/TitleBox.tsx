import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { StringLiteral } from "@babel/types";
import { resourceTopology } from "../Topologies/ResourceTopology";

interface TitleBoxProps {
  name: StringLiteral;
}

const TitleBox = (props: TitleBoxProps) => {
  const { name } = props;

  return (
    <h2>
      {name.value}
    </h2>
  );
}

TitleBox.type = NS.schema("Thing");

TitleBox.topology = resourceTopology;

TitleBox.property = [
  NS.schema("name"),
  NS.as("name"),
  NS.rdfs("label"),
  NS.foaf("name"),
];

TitleBox.mapDataToProps = [
  NS.schema("name"),
];

export default register(TitleBox);
