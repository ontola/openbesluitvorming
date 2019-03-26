import React from "react";
import throttle from "lodash.throttle";
import Resizable from "re-resizable";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight, faArrowLeft, faSpinner } from "@fortawesome/free-solid-svg-icons";
import { withRouter, RouteComponentProps } from "react-router";
import { usePersistedState } from "../helpers";
const { Document, Page, pdfjs } = require("react-pdf");
// tslint:disable-next-line:max-line-length
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.js`;

export interface PDFViewerProps {
  url: string;
  searchTerm: string | null;
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

interface TextLayerItem {
  str: string;
}

const MARGIN_LEFT = 200;

const calcMaxWidth = (windowWidth: number) => {
  if (windowWidth > 800) {
    return windowWidth - MARGIN_LEFT;
  }

  return windowWidth;
};

const determineInitialWith = (windowWidth: number) => {
  if (windowWidth < 800) {
    return windowWidth;
  }
  return windowWidth - 600;
};

const LoadingComponent = () =>
  <div className="PDFViewer__loading">
    <FontAwesomeIcon icon={faSpinner} size="6x" spin />
  </div>;

const PDFViewer = (props: PDFViewerProps & RouteComponentProps) => {
  const [pageNumber, setPageNumber] = React.useState<number>(1);
  const [numPages, setNumPages] = React.useState<number>(0);
  const [width, setWidth] =
    usePersistedState<number>("orisearch.pdfviewer.width", determineInitialWith(window.innerWidth));
  const [maxWidth, setMaxWidth] = React.useState<number>(calcMaxWidth(window.innerWidth));

  const pdfWrapper = React.createRef<HTMLInputElement>();

  React.useLayoutEffect(() => {
    const handleResize = () => {
      if (pdfWrapper.current) {
        setWidth(pdfWrapper.current.getBoundingClientRect().width);
        setMaxWidth(calcMaxWidth(window.innerWidth));
      }
    };

    const listener = throttle(handleResize, 500);
    window.addEventListener("resize", listener);

    return () => window.removeEventListener("resize", listener);
  });

  const onDocumentLoadSuccess = (e: OnLoadSuccessType) => {
    setNumPages(e.numPages);
    setPageNumber(1);
  };

  const closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showDocument");
    props.history.push(`/search?${params.toString()}`);
  };

  const highlightPattern = (text: string, pattern: string): React.ReactNode => {
    const splitText = text.split(pattern);

    if (splitText.length <= 1) {
      return text;
    }

    const matches = text.match(pattern);

    const whatever = splitText.reduce<React.ReactNode[]>(
      (arr, element, index) => {
        if (matches && matches[index]) {
          return [
            ...arr,
            element,
            <mark>
              {matches[index]}
            </mark>,
          ];
        }
        return [...arr, element];
      },
      [],
    );

    return (
      <React.Fragment>
        {whatever}
      </React.Fragment>
    );
  };

  const makeTextRenderer = (searchText: string) =>
    (textItem: TextLayerItem) => highlightPattern(textItem.str, searchText);

  return (
    <Resizable
      size={{ width, height: "100%" }}
      className="PDFViewer"
      handleClasses={{
        left: "PDFViewer__resize-handle",
      }}
      maxWidth={maxWidth}
      minWidth={200}
      onResizeStop={(_e, _direction, _ref, d) => setWidth(width + d.width)}
      enable={{ left: true }}
    >
      <Button
        className="Button__close"
        onClick={closeDocument}
      >
        Sluiten
      </Button>
      <div
        id="row"
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          position: "relative",
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <div id="pdfWrapper" style={{ width: "100%" }} ref={pdfWrapper}>
          <Document
            file={props.url}
            loading={<LoadingComponent/>}
            onLoadSuccess={onDocumentLoadSuccess}
          >
            <Page
              loading={<LoadingComponent/>}
              pageIndex={pageNumber - 1}
              width={width}
              customTextRenderer={props.searchTerm && makeTextRenderer(props.searchTerm)}
            />
          </Document>
        </div>
      </div>
      <div className="PDFViewer__button-bar">
        <div className="PDFViewer__button-bar-inner">
          <Button
            onClick={() => setPageNumber(pageNumber - 1)}
            disabled={(pageNumber === 1)}
            title="Vorige pagina"
          >
            <FontAwesomeIcon icon={faArrowLeft} />
          </Button>
          <span>{`${pageNumber} / ${numPages}`}</span>
          <Button
            onClick={() => setPageNumber(pageNumber + 1)}
            disabled={(pageNumber === (numPages))}
            title="Volgende pagina"
          >
            <FontAwesomeIcon icon={faArrowRight} />
          </Button>
        </div>
      </div>
    </Resizable>
  );
};

export default withRouter(PDFViewer);
