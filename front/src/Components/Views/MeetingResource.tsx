import { register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { resourceTopology } from "../Topologies/ResourceTopology";
import Box from "../Topologies/BoxTopology";
import { labelsTopology } from "../Topologies/LabelsTopology";
import { ThingProps } from "./Thing";
import { propertyValueTopology } from "../Topologies/PropertyValueTopology";

interface MeetingResourceProps extends ThingProps {
  name: SomeTerm;
  date: SomeTerm;
}

/** A Thing inside the Resource or Labels topology */
const ThingResource = (props: MeetingResourceProps) => {
  let labelString = props.subject.value;

  if (props.name !== undefined) {
    // labelString = props.label.value;
    labelString = props.name.value;
  }

  const date = new Date(props.date.value);

  return <Box>{`${labelString} - ${date.toLocaleDateString("nl-NL")}`}</Box>;
};

ThingResource.type = NS.meeting("Meeting");
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
  date: [NS.schema("startDate")],
};
ThingResource.linkOpts = {
  forceRender: true,
};

export default register(ThingResource);
