import { TopologyProvider, unstable } from "link-redux";
import React from "react";
import { NS } from "../../LRS";

export const resourceTopology = NS.app("resourceTopology");

class Resource extends TopologyProvider {
  constructor(props: {}) {
    super(props);

    this.topology = resourceTopology;
  }

  static contextType = unstable.LinkRenderCtx;

  static topology = resourceTopology;

  render() {
    return this.wrap(subject => (
      <div
        className={"Resource"}
        resource={subject && subject.value}
      >
        {this.props.children}
      </div>
    ));
  }
}

export default Resource;
