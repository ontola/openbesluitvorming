import { Property, register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import DownloadResource from "../DownloadResource";
import { StringLiteral } from "@babel/types";
import Resource from "../Topologies/ResourceTopology";
import Labels from "../Topologies/LabelsTopology";

interface ThingProps {
  subject: StringLiteral;
}

const Thing = (props: ThingProps) => {
  return (
    <Resource>
      <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
      <div className="Resource__details">
        {props.subject &&
          <DownloadResource url={props.subject.value} />
        }
      </div>
      <Labels>
        <Property label={NS.rdfs("type")} /><br />
        <Property label={NS.schema("dateModified")} /><br />
        <Property label={NS.prov("hadPrimarySo")} />
      </Labels>
    </Resource>
  );
};

Thing.type = NS.schema("Thing");

Thing.linkOpts = {
  forceRender: true,
};

export default register(Thing);
