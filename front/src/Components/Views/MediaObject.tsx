import { Property, register } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import Resource from "../Topologies/ResourceTopology";
import Labels from "../Topologies/LabelsTopology";
import DownloadResource from "../DownloadResource";
import { SomeNode } from "link-lib";

interface MediaObjectProps {
  subject: SomeNode;
}

// Mostly PDF objects
const MediaObject = (props: MediaObjectProps) => {
  return (
    <React.Fragment>
      <Resource>
        <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
        PDF document <br/>
        <DownloadResource url={props.subject.value} />
        <Labels>
          <Property label={NS.schema("dateModified")} />
          <Property label={NS.schema("fileSize")} />
          <Property label={NS.schema("encodingFormat")} />
          <Property label={NS.schema("contentUrl")} />
        </Labels>
      </Resource>
      <Property label={NS.schema("isBasedOn")} />
    </React.Fragment>
  );
}

MediaObject.type = NS.schema("MediaObject");

export default register(MediaObject);
