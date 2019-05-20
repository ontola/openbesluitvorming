import { Property, register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { resourceTopology } from "../Topologies/ResourceTopology";
import Box from "../Topologies/BoxTopology";

const ThingResource = () => {
  return (
    <Box>
      <Property label={[NS.schema("name"), NS.schema("label")]} />
    </Box>
  );
};

ThingResource.type = NS.schema("Thing");
ThingResource.topology = resourceTopology;

export default register(ThingResource);
