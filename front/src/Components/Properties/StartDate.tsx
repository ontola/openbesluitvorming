import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "@ontologies/core";
import schema from "@ontologies/schema";

interface StartDateProps {
  linkedProp: NamedNode;
}

const StartDate = (props: StartDateProps) => {
  const { linkedProp } = props;

  const date = new Date(linkedProp.value);

  return (
    <span title={date.toISOString()}>Start: {date.toDateString()}</span>
  );
}

StartDate.type = schema.Thing;

StartDate.property = schema.startDate;


export default register(StartDate);
