import React from "react";
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

function usePersistedState<T>(key: string, initial: T):
  [T, React.Dispatch<React.SetStateAction<T>>] {

  const [value, setValue] = React.useState<T>(() => {
    const storageValue = sessionStorage.getItem(key);
    if (storageValue) {
      return JSON.parse(storageValue) || initial;
    }

    return initial;
  });

  const setPersistedValue = (next: T | React.SetStateAction<T>): void => {
    sessionStorage.setItem(key, JSON.stringify(next));
    setValue(next);
  };

  return [value, setPersistedValue];
}

const PDFViewer = (props: PDFViewerProps & RouteComponentProps) => {
  const [pageNumber] = React.useState<number>(1);
  const [, setNumPages] = React.useState<number>(0);
  const [width, setWidth] = usePersistedState<number>("orisearch.pdfviewer.width", 300);
  const [maxWidth, setMaxWidth] = React.useState<number>(calcMaxWidth(window.outerWidth));

  const pdfWrapper = React.createRef<HTMLInputElement>();

  React.useLayoutEffect(() => {
    const handleResize = () => {
      if (pdfWrapper.current) {
        setWidth(pdfWrapper.current.getBoundingClientRect().width);
        setMaxWidth(calcMaxWidth(window.outerWidth));
      }
    };

    const listener = throttle(handleResize, 500);
    window.addEventListener("resize", listener);

    return () => window.removeEventListener("resize", listener)
  });

  const onDocumentLoadSuccess = (e: OnLoadSuccessType) => {
    setNumPages(e.numPages);
  };

  const closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showDocument");
    props.history.push(`/search?${params.toString()}`);
  };

  return (
    <Resizable
      size={{ width, height: "100%" }}
      maxWidth={maxWidth}
      minWidth={200}
      onResizeStop={(_e, _direction, _ref, d) => setWidth(width + d.width)}
      enable={{ left: true }}
    >
      <Button
        onClick={closeDocument}
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
        <div id="pdfWrapper" style={{ width: "100%" }} ref={pdfWrapper}>
          <Document
            file={props.url}
            onLoadSuccess={onDocumentLoadSuccess}
          >
            <Page pageIndex={pageNumber} width={width} />
          </Document>
        </div>
      </div>
    </Resizable>
  );
};

export default withRouter(PDFViewer);
