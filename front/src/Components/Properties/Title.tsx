import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { StringLiteral } from "@babel/types";
import { resourceTopology } from "../Topologies/ResourceTopology";

interface TitleProps {
  label: StringLiteral;
  prefLabel: StringLiteral;
  name: StringLiteral;
}

const Title = (props: TitleProps) => {
  return (
    <h1>
      {props.name.value}
    </h1>
  );
}

Title.type = NS.schema("Thing");

Title.topology = resourceTopology;

Title.property = [
  NS.schema("name"),
  NS.as("name"),
  NS.rdfs("label"),
  NS.foaf("name"),
  NS.skos("prefLabel"),
];

Title.mapDataToProps = {
  name: [
    NS.schema("name"),
    NS.as("name"),
    NS.rdfs("label"),
    NS.foaf("name"),
    NS.skos("prefLabel"),
  ],
};

export default register(Title);
