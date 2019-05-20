import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "rdflib";

import { NS } from "../../LRS";

interface DateModifiedProps {
  linkedProp: NamedNode;
}

class DateModified extends React.Component<DateModifiedProps> {
  static type = NS.schema.Thing;

  static property = NS.schema.dateModified;

  render() {
    const { linkedProp } = this.props;

    const date = new Date(linkedProp.value);

    return (
      <span title={date.toISOString()}>{date.toDateString()}</span>
    );
  }
}

export default register(DateModified);
