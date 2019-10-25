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
        <Property label={[NS.schema("name"), NS.schema("label")]} />
        <div className="Resource__details">
          PDF document
          {" - "}
          <DownloadResource url={props.subject.value} />
        </div>
        <Labels>
          <Property label={NS.vcard("hasOrganizationName")} />
          <Property label={NS.dcterms("isReferencedBy")} />
          <Property label={NS.schema("dateModified")} />
          <Property label={NS.schema("isBasedOn")} />
          {/* <Property label={NS.schema("fileSize")} />
          <Property label={NS.schema("encodingFormat")} /> */}
        </Labels>
      </Resource>
      {/* TODO: Resolve PDFs, use contentURL */}
      {/* <Property label={NS.schema("contentUrl")} /> */}
      <Property label={NS.schema("contentUrl")} />
    </React.Fragment>
  );
};

MediaObject.type = NS.schema("MediaObject");

export default register(MediaObject);
