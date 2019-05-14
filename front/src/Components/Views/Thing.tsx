import { Property, register } from "link-redux";
import React, { PureComponent } from "react";

import { NS } from "../../LRS";

class ThingPage extends PureComponent {
  static type = NS.schema("Thing");

  render() {
    return (
      // @ts-ignore
      <Property label={NS.schema("name")} />
    );
  }
}

export default register(ThingPage);
