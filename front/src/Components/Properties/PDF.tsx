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

const PdfProp = (props: PdfProps) => {
  const { linkedProp } = props;

  return (
    <PDFViewer url={linkedProp.value} />
  );
}

PdfProp.type = schema.Thing;

PdfProp.property = schema.contentUrl;


export default register(PdfProp);
