import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface OrganizationProps {
  subject: SomeNode;
  attachment: SomeNode;
}

const Organization = (props: OrganizationProps) => {
  return (
    <ResourceTopology>
      <Property label={NS.skos("prefLabel")} />
      <div className="Resource__details">
        Organisatie
        {" - "}
        <DownloadResource url={props.subject.value} />
      </div>
      <Labels>
        <Property label={NS.dcterms("description")} />
        <Property label={NS.org("subOrganizationOf")} />
        <Property label={NS.ncal("categories")} />
        <Property label={NS.vcard("email")} />
        <Property label={NS.vcard("url")} />
        <Property label={NS.meta("collection")} />
        <Property label={NS.prov("wasGeneratedBy")} />
        <Property label={NS.schema("superEvent")} />
        <Property label={NS.meeting("attachment")} limit={100}/>
      </Labels>
    </ResourceTopology>
  );
};

Organization.type = NS.org("Organization");

export default register(Organization);
