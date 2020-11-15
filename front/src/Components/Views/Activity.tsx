import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface ActivityProps {
  subject: SomeNode;
}

const Activity = (props: ActivityProps) => {
  return (
    <ResourceTopology>
      <Property label={NS.foaf("name")} />
      <div className="Resource__details">
        Meta - Activiteit
        {" - "}
        <DownloadResource url={props.subject.value} />
      </div>
      <Labels>
        <Property label={NS.owl("endedAtTime")} />
        <Property label={NS.prov("endedAtTime")} />
        <Property label={NS.prov("startedAtTime")} />
        <Property label={NS.prov("generated")} />
        <Property label={NS.meeting("referenceIdentifier")} />
        <Property label={NS.meeting("semver")} />
      </Labels>
    </ResourceTopology>
  );
};

Activity.type = NS.person("Person");

export default register(Activity);
