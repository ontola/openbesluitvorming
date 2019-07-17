import { TopologyProvider, unstable, withLRS, LinkReduxLRSType } from "link-redux";
import React from "react";
import { NS } from "../../LRS";
import Button from "../Button";

export const boxTopology = NS.app("boxTopology");

interface TopologyProviderProps {
  lrs: LinkReduxLRSType;
  elementProps?: object;
}

class Box extends TopologyProvider<TopologyProviderProps> {
  constructor(props: TopologyProviderProps) {
    super(props);

    this.topology = boxTopology;
  }

  static contextType = unstable.LinkRenderCtx;

  static topology = boxTopology;

  render() {

    return this.wrap(subject => (
      <Button
        onClick={(e) => {
          e.preventDefault();
          this.props.lrs.actions.app.showResource(subject);
        }}
        className="Box"
      >
        {this.props.children}
      </Button>
    ));
  }
}

export default withLRS(Box);
