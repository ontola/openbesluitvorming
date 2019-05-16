import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { StringLiteral } from "@babel/types";

interface TitleProps {
  name: StringLiteral;
}

class Title extends React.Component<TitleProps> {

  static type = NS.schema("Thing");

  static property = [
    NS.schema("name"),
    NS.as("name"),
    NS.rdfs("label"),
    NS.foaf("name"),
  ];

  static mapDataToProps = [
    NS.as("actor"),
    NS.schema("name"),
    NS.as("target"),
    NS.as("object"),
  ];

  render() {
    const { name } = this.props;

    return (
      <h1>
        {name.value}
      </h1>
    );
  }
}

export default register(Title);
