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
      <Property label={NS.schema("name")} />
      <div className="Resource__details">
        Vergadering
        {" - "}
        <DownloadResource url={props.subject.value} />
      </div>
      <Labels>
        <Property label={NS.vcard("hasOrganizationName")} />
        <Property label={NS.schema("description")} />
        <Property label={NS.schema("location")} />
        <Property label={NS.schema("startDate")} />
        <Property label={NS.schema("endDate")} />
        {/* TODO: List support */}
        {/* <Property label={NS.ncal("categories")} /> */}
        <Property label={NS.schema("organizer")} />
        <Property label={NS.meeting("committee")} />
        <Property label={NS.meeting("attachment")} limit={100}/>
        <Property label={NS.meeting("agenda")} limit={100}/>
        <Property label={NS.schema("invitee")} limit={100}/>
      </Labels>
    </ResourceTopology>
  );
};

Meeting.type = [NS.meeting("Meeting"), NS.meeting("Report")];

export default register(Meeting);
