import { register } from "link-redux";
import React from "react";
import { NamedNode } from "rdflib";

import { NS } from "../../LRS";

interface TypeProps {
  linkedProp: NamedNode;
}

const Type = (props: TypeProps) => {
  return (
    <div>
      {props.linkedProp.value}
    </div>
  );
};

Type.type = NS.rdfs("type");

export default register(Type);
