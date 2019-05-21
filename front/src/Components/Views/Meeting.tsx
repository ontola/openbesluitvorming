import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface MeetingProps {
  subject: SomeNode;
  attachment: SomeNode;
}

const Meeting = (props: MeetingProps) => {
  return (
    <ResourceTopology>
      <Property label={NS.schema("name")} /><br />
      Vergadering<br />
      <DownloadResource url={props.subject.value} />
      <Labels>
        <Property label={NS.schema("description")} />
        <Property label={NS.schema("startDate")} />
        <Property label={NS.ncal("categories")} />
        <Property label={NS.meeting("committee")} />
        <Property label={NS.meeting("attachment")} limit={100}/>
        <Property label={NS.meeting("agenda")}/>
      </Labels>
    </ResourceTopology>
  );
};

Meeting.mapDataToProps = [
  NS.meeting("attachment"),
];
Meeting.type = NS.meeting("Meeting");

export default register(Meeting);
