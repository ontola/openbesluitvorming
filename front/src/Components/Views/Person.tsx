import { register, Property } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import ResourceTopology from "../Topologies/ResourceTopology";
import { SomeNode } from "link-lib";
import DownloadResource from "../DownloadResource";
import Labels from "../Topologies/LabelsTopology";

interface PersonProps {
  subject: SomeNode;
}

const Person = (props: PersonProps) => {
  return (
    <ResourceTopology>
      <Property label={NS.foaf("name")} />
      <div className="Resource__details">
        Persoon
        {" - "}
        <DownloadResource url={props.subject.value} />
      </div>
      <Labels>
        <Property label={NS.vcard("hasOrganizationName")} />
        <Property label={NS.org("memberOf")} />
        <Property label={NS.foaf("gender")} />
      </Labels>
    </ResourceTopology>
  );
};

Person.type = NS.person("Person");

export default register(Person);
