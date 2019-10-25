import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "@ontologies/core";
import schema from "@ontologies/schema";

interface StartDateProps {
  linkedProp: NamedNode;
}

class StartDate extends React.Component<StartDateProps> {
  static type = schema.Thing;

  static property = schema.startDate;

  render() {
    const { linkedProp } = this.props;

    const date = new Date(linkedProp.value);

    return (
      <span title={date.toISOString()}>Start: {date.toDateString()}</span>
    );
  }
}

export default register(StartDate);
