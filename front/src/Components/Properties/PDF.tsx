import {
  register,
} from "link-redux";
import React from "react";
import { NamedNode } from "@ontologies/core";
import schema from "@ontologies/schema";

import PDFViewer from "../PDFViewer";

interface PdfProps {
  linkedProp: NamedNode;
}

class PdfProp extends React.Component<PdfProps> {
  static type = schema.Thing;

  static property = schema.contentUrl;

  render() {
    const { linkedProp } = this.props;

    return (
      <PDFViewer url={linkedProp.value} />
    );
  }
}

export default register(PdfProp);
