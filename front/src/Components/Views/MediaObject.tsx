import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";
import Resource from "../Topologies/ResourceTopology";

// Mostly PDF objects
class MediaObject extends PureComponent {
  static type = NS.schema("MediaObject");

  render() {
    return (
      <React.Fragment>
        <Resource>
          <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
          PDF document <br/>
          <Property label={NS.schema("dateModified")} /><br />
        </Resource>
        <Property label={NS.schema("isBasedOn")} />
      </React.Fragment>
    );
  }
}

export default register(MediaObject);
