import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "@ontologies/core";
import schema from "@ontologies/schema";

import allTopologies from "../Topologies/allTopologies";

interface DateModifiedProps {
  linkedProp: NamedNode;
}

class DateModified extends React.Component<DateModifiedProps> {
  static type = schema.Thing;

  static property = [
    schema.dateModified,
    schema.startDate,
    schema.endDate,
  ];
  static topology = allTopologies;

  render() {
    const { linkedProp } = this.props;

    const date = new Date(linkedProp.value);

    return (
      <span title={date.toISOString()}>{date.toLocaleDateString('nl-NL')}</span>
    );
  }
}

export default register(DateModified);
