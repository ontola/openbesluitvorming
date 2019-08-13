import React from "react";
import { register, Property } from "link-redux";

import { NS } from "../../LRS";
import allTopologies from "../Topologies/allTopologies";

const RDFList = () => {
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
