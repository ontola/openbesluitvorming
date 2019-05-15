import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";

class ThingPage extends PureComponent {
  static type = NS.schema("Thing");

  render() {
    return (
      <React.Fragment>
        <Property label={[NS.schema("name"), NS.schema("label")]} />
        <Property label={NS.schema("dateModified")} />
        <Property label={NS.prov("hadPrimarySo")} />
      </React.Fragment>
    );
  }
}

export default register(ThingPage);
