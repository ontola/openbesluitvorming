import React, { PureComponent } from "react";
import throttle from "lodash.throttle";
import Resizable from "re-resizable";
const { Document, Page, pdfjs } = require("react-pdf");
// tslint:disable-next-line:max-line-length
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.js`;

export interface PDFViewerProps {
  url: string;
}

export interface PDFViewerState {
  numPages: null | number;
  pageNumber: number;
  width: number;
}

interface OnLoadSuccessType {
  numPages: number;
}

class PDFViewer extends PureComponent<PDFViewerProps, PDFViewerState> {
  private pdfWrapper: React.RefObject<HTMLInputElement>;
  constructor(props: PDFViewerProps) {
    super(props);
    this.state = {
      width: 0,
      pageNumber: 1,
      numPages: null,
    };
    this.pdfWrapper = React.createRef();
  }

  componentDidMount () {
    this.setDivSize();
    window.addEventListener("resize", throttle(this.setDivSize, 500));
  }

  componentWillUnmount () {
    window.removeEventListener("resize", throttle(this.setDivSize, 500));
  }

  setDivSize = () => {
    this.pdfWrapper.current && this.setState({
      width: this.pdfWrapper.current.getBoundingClientRect().width,
    });
  }

  onDocumentLoadSuccess = (args: OnLoadSuccessType) => {
    this.setState({ numPages: args.numPages });
  }

  render() {
    return (
      <Resizable
        size={{ width: this.state.width || 100, height: "100%" }}
        onResizeStop={(e, direction, ref, d) => {
          this.setState({
            width: this.state.width + d.width || 100 + d.width,
          });
        }}
        enable={{ left: true}}
      >
        <div
          onKeyDown={(e: any) => console.log(e.keyCode)}
          id="row"
          style={{
            height: "100%",
            width: "100%",
            display: "flex",
            overflow: "scroll",
          }}
        >
          <div id="pdfWrapper" style={{ width: "100%" }} ref={this.pdfWrapper}>
            <Document
              file={this.props.url}
              onLoadSuccess={this.onDocumentLoadSuccess}
            >
              <Page pageIndex={1} width={this.state.width} />
            </Document>
          </div>
        </div>
      </Resizable>
    );
  }
}

export default PDFViewer;
