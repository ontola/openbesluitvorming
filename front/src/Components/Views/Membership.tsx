import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface MembershipProps {
  subject: SomeNode;
}

const Membership = (props: MembershipProps) => {
  return (
    <ResourceTopology>
      <div className="Resource__details">
        Lidmaatschap
        {" - "}
        <DownloadResource url={props.subject.value} />
      </div>
      <Labels>
        <Property label={NS.org("member")} limit={100} />
        <Property label={NS.org("role")} />
        <Property label={NS.org("organization")} />
      </Labels>
    </ResourceTopology>
  );
};

Membership.type = NS.org("Membership");

export default register(Membership);
