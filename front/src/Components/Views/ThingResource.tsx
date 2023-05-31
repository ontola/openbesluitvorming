import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { resourceTopology } from "../Topologies/ResourceTopology";
import Box from "../Topologies/BoxTopology";
import { labelsTopology } from "../Topologies/LabelsTopology";
import { ThingProps } from "./Thing";
import { propertyValueTopology } from "../Topologies/PropertyValueTopology";

interface ThingResourceProps extends ThingProps {
  name: SomeTerm;
}

/** A Thing inside the Resource or Labels topology */
const ThingResource = (props: ThingResourceProps) => {
  let labelString = props.subject.value;

  if (props.name !== undefined) {
    // labelString = props.label.value;
    labelString = props.name.value;
  }

  return <Box>{labelString}</Box>;
};

ThingResource.type = NS.schema("Thing");
ThingResource.topology = [
  resourceTopology,
  propertyValueTopology,
  labelsTopology,
];
ThingResource.mapDataToProps = {
  name: [
    NS.schema("name"),
    NS.foaf("name"),
    NS.rdfs("label"),
    NS.schema("label"),
    NS.skos("prefLabel"),
  ],
};
ThingResource.linkOpts = {
  forceRender: true,
};

export default register(ThingResource);
