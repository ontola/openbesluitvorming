import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";

class ThingPage extends PureComponent {
  static type = NS.schema("Thing");

  render() {
    return (
      <div className="Resource">
        type: <br />
        <Property label={NS.rdfs("type")} /><br />
        date modified: <br />
        <Property label={NS.schema("dateModified")} /><br />
        hadPrimarySo: <br />
        <Property label={NS.prov("hadPrimarySo")} /><br />
      </div>
    );
  }
}

export default register(ThingPage);
