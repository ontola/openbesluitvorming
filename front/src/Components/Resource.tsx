import { LinkedResourceContainer } from "link-redux";
import { NamedNode } from "rdflib";
import * as React from "react";
// import PDFViewer from "../Components/PDFViewer";

interface ResourceProps {
  url: string;
  width: number;
  setWidth: Function;
  searchTerm: string | null;
}

const Resource: React.FunctionComponent<ResourceProps> = (props) => {
  return (
    <div className="Resource">
      <LinkedResourceContainer subject={NamedNode.find(props.url)} />
      {/* <PDFViewer
        url={props.url}
        searchTerm={props.searchTerm}
        width={props.width}
        setWidth={props.setWidth}
      /> */}
    </div>
  );
};

export default Resource;
