import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";

// Mostly PDF objects
class MediaObject extends PureComponent {
  static type = NS.schema("MediaObject");

  render() {
    return (
      <React.Fragment>
        <div className="Resource">
          <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
          PDF document <br/>
          date modified: <br />
          <Property label={NS.schema("dateModified")} /><br />
        </div>
        <Property label={NS.schema("isBasedOn")} /><br />
      </React.Fragment>
    );
  }
}

export default register(MediaObject);
