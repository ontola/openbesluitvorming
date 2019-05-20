import { Property, register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import DownloadResource from "../DownloadResource";
import { StringLiteral } from "@babel/types";
import Resource from "../Topologies/ResourceTopology";

interface ThingProps {
  subject: StringLiteral;
}

const Thing = (props: ThingProps) => {
  return (
    <Resource>
      <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
      type: <br />
      <Property label={NS.rdfs("type")} /><br />
      date modified: <br />
      <Property label={NS.schema("dateModified")} /><br />
      hadPrimarySo: <br />
      <Property label={NS.prov("hadPrimarySo")} />
      <DownloadResource url={props.subject.value} />
    </Resource>
  );
};

Thing.type = NS.schema("Thing");

Thing.linkOpts = {
  forceRender: true,
};

export default register(Thing);
