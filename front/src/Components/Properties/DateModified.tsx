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

const DateModified = (props: DateModifiedProps) => {
  const { linkedProp } = props;

  const date = new Date(linkedProp.value);

  return (
    <span title={date.toISOString()}>{date.toLocaleDateString('nl-NL')}</span>
  );
}

DateModified.type = schema.Thing;
DateModified.property = [
  schema.dateModified,
  schema.startDate,
  schema.endDate,
];
DateModified.topology = allTopologies;


export default register(DateModified);
