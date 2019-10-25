import { register } from "link-redux";
import React from "react";
import { NamedNode } from "@ontologies/core";

import { NS } from "../../LRS";
import { resourceTopology } from "../Topologies/ResourceTopology";

interface TypeProps {
  linkedProp: NamedNode;
  description: NamedNode;
  label: NamedNode;
}

const Type = (props: TypeProps) => {
  return (
    <div>
      Type: {props.description}
    </div>
  );
};

Type.mapDataToProps = [
  NS.schema("description"),
  NS.rdfs("label"),
];
Type.type = NS.rdfs("type");
Type.topology = resourceTopology;

export default register(Type);
