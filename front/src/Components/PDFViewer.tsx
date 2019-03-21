import React, { PureComponent } from "react";
import throttle from "lodash.throttle";
import Resizable from "re-resizable";
import Button from "./Button";
import { withRouter, RouteComponentProps } from "react-router";
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
  // Should equal 70vw on desktops, 100vw on mobile
  maxWidth: number;
}

interface OnLoadSuccessType {
  numPages: number;
}

const MARGIN_LEFT = 200;

const calcMaxWidth = (windowWidth: number) => {
  console.log(windowWidth);
  if (windowWidth > 800) {
    return windowWidth - MARGIN_LEFT;
  }

  return windowWidth;
};

class PDFViewer extends PureComponent<PDFViewerProps & RouteComponentProps, PDFViewerState> {
  private pdfWrapper: React.RefObject<HTMLInputElement>;
  constructor(props: (PDFViewerProps & RouteComponentProps)) {
    super(props);
    this.state = {
      width: 300,
      pageNumber: 1,
      numPages: null,
      maxWidth: calcMaxWidth(window.outerWidth),
    };
    this.pdfWrapper = React.createRef();
  }

  componentDidMount () {
    this.handleResize();
    window.addEventListener("resize", throttle(this.handleResize, 500));
  }

  componentWillUnmount () {
    window.removeEventListener("resize", throttle(this.handleResize, 500));
  }

  handleResize = () => {
    this.pdfWrapper.current && this.setState({
      maxWidth: calcMaxWidth(window.outerWidth),
      width: this.pdfWrapper.current.getBoundingClientRect().width,
    });
  }

  closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showDocument");
    this.props.history.push(`/search?${params.toString()}`);
  }

  onDocumentLoadSuccess = (args: OnLoadSuccessType) => {
    this.setState({ numPages: args.numPages });
  }

  render() {
    return (
      <Resizable
        size={{ width: this.state.width, height: "100%" }}
        maxWidth={this.state.maxWidth}
        minWidth={200}
        onResizeStop={(e, direction, ref, d) => {
          this.setState({
            width: this.state.width + d.width,
          });
        }}
        enable={{ left: true }}
      >
        <Button
          onClick={this.closeDocument}
          className="Button__close"
        >
          Sluiten
        </Button>
        <div
          onKeyDown={(e: any) => console.log(e.keyCode)}
          id="row"
          style={{
            height: "100%",
            width: "100%",
            display: "flex",
            "overflow-y": "auto",
            "overflow-x": "hidden",
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

export default withRouter(PDFViewer);
