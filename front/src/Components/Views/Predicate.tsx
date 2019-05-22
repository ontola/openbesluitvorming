import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { labelsTopology } from "../Topologies/LabelsTopology";
import { NamedNode } from "rdflib";

interface PredicateProps {
  children: React.ReactNode;
  label: NamedNode | NamedNode[];
}

const Predicate = (props: PredicateProps) => {
  const { label } = props;
  return (
    <div className="LabelItem">
      <div className="LabelItem__label">
        {label && Array.isArray(label) ? label[0].term : label.term}
      </div>
      <div>{props.children}</div>
    </div>
  );
};

Predicate.property = NS.rdf("predicate");
Predicate.topology = labelsTopology;
Predicate.type = NS.schema("Thing");

// @ts-ignore
export default register(Predicate);
