import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "rdflib";

import { NS } from "../../LRS";

interface StartDateProps {
  linkedProp: NamedNode;
}

class StartDate extends React.Component<StartDateProps> {
  static type = NS.schema.Thing;

  static property = NS.schema.startDate;

  render() {
    const { linkedProp } = this.props;

    const date = new Date(linkedProp.value);

    return (
      <span title={date.toISOString()}>Start: {date.toDateString()}</span>
    );
  }
}

export default register(StartDate);
