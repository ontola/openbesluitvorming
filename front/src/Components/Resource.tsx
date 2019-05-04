// import { LinkedResourceContainer } from "link-redux";
import { NamedNode } from "rdflib";
import * as React from "react";

interface ResourceProps {
  url: string;
}

const Resource: React.FunctionComponent<ResourceProps> = (props) => {
  return (
    <div className="Resource">
      {/* <LinkedResourceContainer subject={NamedNode.find(props.url)} /> */}
    </div>
  );
};

export default Resource;
