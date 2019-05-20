import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";

interface AgendaItemProps {
  subject: SomeNode;
}

const AgendaItem = (props: AgendaItemProps) => {
  return (
    <ResourceTopology>
      <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
      AgendaPunt<br />
      <Property label={NS.schema("description")} /><br />
      <Property label={NS.schema("startDate")} /><br />
      <Property label={NS.schema("superEvent")} /><br />
      <Property label={NS.meeting("attachment")} /><br />
    </ResourceTopology>
  );
};

AgendaItem.type = NS.meeting("AgendaItem");

export default register(AgendaItem);
