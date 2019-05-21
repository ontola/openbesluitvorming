import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";
import Resource from "../Topologies/ResourceTopology";
import Labels from "../Topologies/LabelsTopology";

// Mostly PDF objects
class MediaObject extends PureComponent {
  static type = NS.schema("MediaObject");

  render() {
    return (
      <React.Fragment>
        <Resource>
          <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
          PDF document <br/>
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
}

export default register(MediaObject);
