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

class Title extends React.Component<TitleProps> {

  static type = NS.schema("Thing");

  static topology = resourceTopology;

  static property = [
    NS.schema("name"),
    NS.as("name"),
    NS.rdfs("label"),
    NS.foaf("name"),
    NS.skos("prefLabel"),
  ];

  static mapDataToProps = [
    NS.schema("name"),
  ];

  render() {
    const { name, label, prefLabel } = this.props;
    const printValue = name.value || label.value || prefLabel.value;

    return (
      <h1>
        {printValue}
      </h1>
    );
  }
}

export default register(Title);
