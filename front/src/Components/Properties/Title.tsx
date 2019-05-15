import { register, LinkedPropType } from "link-redux";
import React from "react";

import { NS } from "../../LRS";

interface TitleProps {
  name: LinkedPropType;
}

class Title extends React.Component<TitleProps> {

  static type = NS.rdfs("Resource");

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
        {name}
      </h1>
    );
  }
}

export default register(Title);
