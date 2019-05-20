import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { StringLiteral } from "@babel/types";
import { resourceTopology } from "../Topologies/ResourceTopology";

interface TitleBoxProps {
  name: StringLiteral;
}

class TitleBox extends React.Component<TitleBoxProps> {

  static type = NS.schema("Thing");

  static topology = resourceTopology;

  static property = [
    NS.schema("name"),
    NS.as("name"),
    NS.rdfs("label"),
    NS.foaf("name"),
  ];

  static mapDataToProps = [
    NS.schema("name"),
  ];

  render() {
    const { name } = this.props;

    return (
      <h2>
        {name.value}
      </h2>
    );
  }
}

export default register(TitleBox);
