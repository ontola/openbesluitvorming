import { TopologyProvider, unstable } from "link-redux";
import React from "react";
import { NS } from "../../LRS";

export const propertyValueTopology = NS.app("propertyValueTopology");

class PropertyValue extends TopologyProvider {
  constructor(props: {}) {
    super(props);

    this.topology = propertyValueTopology;
  }

  static contextType = unstable.LinkRenderCtx;

  static topology = propertyValueTopology;

  render() {
    return this.wrap(subject => (
      <div
        className={"PropertyValue"}
        resource={subject && subject.value}
      >
        {this.props.children}
      </div>
    ));
  }
}

export default PropertyValue;
