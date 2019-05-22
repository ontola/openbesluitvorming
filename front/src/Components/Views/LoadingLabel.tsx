import React from "react";
import { register } from "link-redux";

import { NS } from "../../LRS";
import { labelsTopology } from "../Topologies/LabelsTopology";

// Smaller loading component
const LoadingLabel = (props: any) => {

  return (
    <span>Laden...<br/></span>
  );
};

LoadingLabel.type = NS.ll("LoadingResource");
LoadingLabel.topology = labelsTopology;

export default register(LoadingLabel);
