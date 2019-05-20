import { TopologyProvider, unstable } from "link-redux";
import React from "react";
import { NS } from "../../LRS";

export const labelsTopology = NS.app("labelsTopology");

class Labels extends TopologyProvider {
  constructor(props: {}) {
    super(props);

    this.topology = labelsTopology;
  }

  static contextType = unstable.LinkRenderCtx;

  static topology = labelsTopology;

  render() {
    return this.wrap(subject => (
      <div
        className={"Labels"}
      >
        {this.props.children}
      </div>
    ));
  }
}

export default Labels;
