import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "rdflib";

import PDFViewer from "../PDFViewer";
import { NS } from "../../LRS";

interface PdfProps {
  linkedProp: NamedNode;
}

class PdfProp extends React.Component<PdfProps> {
  static type = NS.schema.Thing;

  static property = NS.schema.isBasedOn;

  render() {
    const { linkedProp } = this.props;

    return (
      <PDFViewer
        searchTerm="string"
        width={123}
        setWidth={() => { console.log("setWidth"); }}
        url={linkedProp.value}
        />
    );
  }
}

export default register(PdfProp);
