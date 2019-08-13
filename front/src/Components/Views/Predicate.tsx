import { register, LinkedResourceContainer } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { labelsTopology } from "../Topologies/LabelsTopology";
import { NamedNode } from "rdflib";
import PredicateLabel from "../Topologies/PredicateLabel";
import PropertyValue from "../Topologies/PropertyValueTopology";

interface PredicateProps {
  children: React.ReactNode;
  label: NamedNode | NamedNode[];
}

const Predicate = (props: PredicateProps) => {
  const { label } = props;
  const singleLabel = label && Array.isArray(label) ? label[0] : label;
  if (props.children === undefined) {
    return null;
  }
  return (
    <div className="LabelItem">
      <PredicateLabel>
        <LinkedResourceContainer subject={singleLabel}/>
      </PredicateLabel>
      <PropertyValue>
        {props.children}
      </PropertyValue>
    </div>
  );
};

Predicate.type = NS.schema("Thing");

Predicate.property = NS.rdf("predicate");

Predicate.topology = labelsTopology;

// @ts-ignore
export default register(Predicate);
