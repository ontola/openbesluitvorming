import { TopologyProvider, withLRS, LinkReduxLRSType } from "link-redux";
import React from "react";
import { NS } from "../../LRS";
import Button from "../Button";

export const boxTopology = NS.app("boxTopology");

interface TopologyProviderProps {
  lrs: LinkReduxLRSType;
  elementProps?: object;
}

/**
 * Box - A clickable item that opens the resource of the item in the sidebar
 */
class Box extends TopologyProvider<TopologyProviderProps> {
  constructor(props: TopologyProviderProps) {
    super(props);

    this.topology = boxTopology;
  }

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
