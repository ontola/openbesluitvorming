import { TopologyProvider, unstable } from "link-redux";
import React from "react";
import { NS } from "../../LRS";

export const predicateLabelTopology = NS.app("predicateLabelTopology");

/**
 * PredicateLabel - The label of a single property of a resource
 */
class PredicateLabel extends TopologyProvider {
  constructor(props: {}) {
    super(props);

    this.topology = predicateLabelTopology;
  }

  static contextType = unstable.LinkRenderCtx;

  static topology = predicateLabelTopology;

  render() {
    return this.wrap(() => (
      <div
        className={"LabelItem__label"}
      >
        {this.props.children}
      </div>
    ));
  }
}

export default PredicateLabel;
