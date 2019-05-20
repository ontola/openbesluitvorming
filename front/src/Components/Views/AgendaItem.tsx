import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface AgendaItemProps {
  subject: SomeNode;
  attachment: SomeNode;
}

const AgendaItem = (props: AgendaItemProps) => {
  return (
    <ResourceTopology>
      <Property label={NS.schema("name")} /><br />
      AgendaPunt<br />
      <DownloadResource url={props.subject.value} />
      <Labels>
        <Property label={NS.schema("description")} />
        <Property label={NS.schema("startDate")} />
        <Property label={NS.schema("superEvent")} />
        <Property label={NS.meeting("attachment")} limit={100}/>
      </Labels>
    </ResourceTopology>
  );
};

AgendaItem.mapDataToProps = [
  NS.meeting("attachment"),
];
AgendaItem.type = NS.meeting("AgendaItem");

export default register(AgendaItem);
