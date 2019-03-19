import * as React from "react";
const { Document, Page, pdfjs } = require("react-pdf");
// tslint:disable-next-line:max-line-length
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.js`;

export interface PDFViewerProps {
  url: string;
}

export interface PDFViewerState {
  numPages: null | number;
  pageNumber: number;
}

interface OnLoadSuccessType {
  numPages: number;
}

export default class PDFViewer extends React.Component<PDFViewerProps, PDFViewerState> {
  constructor(props: PDFViewerProps) {
    super(props);

    this.state = {
      numPages: null,
      pageNumber: 1,
    };
  }

  onDocumentLoadSuccess = (args: OnLoadSuccessType) => {
    this.setState({ numPages: args.numPages });
  }

  public render() {
    const { pageNumber, numPages } = this.state;

    return (
      <div>
        <p>Page {pageNumber} of {numPages}</p>
        <Document
          file={this.props.url}
          onLoadSuccess={this.onDocumentLoadSuccess}
          onLoadError={(error: any) => alert('Error while loading document! ' + error.message)}
        >
          <Page pageNumber={pageNumber} />
        </Document>
      </div>
    );
  }
}
