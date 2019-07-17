import React from "react";
import { register, Property } from "link-redux";

import { NS } from "../../LRS";
import { labelsTopology } from "../Topologies/LabelsTopology";

const RDFList = () => {

  return (
    <React.Fragment>
      <Property label={NS.rdf("first")}/>
      <Property label={NS.rdf("rest")}/>
    </React.Fragment>
  );
};

RDFList.type = NS.rdf("List");
RDFList.topology = labelsTopology;

export default register(RDFList);
