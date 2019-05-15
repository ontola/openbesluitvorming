import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";

class ThingPage extends PureComponent {
  static type = NS.schema("Thing");

  render() {
    return (
      <React.Fragment>
        name: <br />
        <Property label={[NS.schema("name"), NS.schema("label")]} /><br />
        type: <br />
        <Property label={NS.rdfs("type")} /><br />
        date modified: <br />
        <Property label={NS.schema("dateModified")} /><br />
        hadPrimarySo: <br />
        <Property label={NS.prov("hadPrimarySo")} /><br />
        isBasedOn: <br />
        <Property label={NS.schema("isBasedOn")} /><br />
      </React.Fragment>
    );
  }
}

export default register(ThingPage);
