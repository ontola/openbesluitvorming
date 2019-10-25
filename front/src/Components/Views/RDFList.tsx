import React from "react";
import { register, Property, useLinkRenderContext } from "link-redux";

import { NS } from "../../LRS";
import allTopologies from "../Topologies/allTopologies";

const RDFList = () => {
  const { subject } = useLinkRenderContext()

  if (subject.value === NS.rdf("nil").value) {
    return null;
  }

  return (
    <React.Fragment>
      <Property label={NS.rdf("first")}/>
      <Property label={NS.rdf("rest")}/>
    </React.Fragment>
  );
};

RDFList.type = NS.rdf("List");
RDFList.topology = allTopologies;

export default register(RDFList);
