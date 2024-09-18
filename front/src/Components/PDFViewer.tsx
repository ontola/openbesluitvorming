import React from "react";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faArrowLeft,
  faSpinner,
  faDownload,
  faExpand,
} from "@fortawesome/free-solid-svg-icons";
import escapeRegExp from "lodash.escaperegexp";
import { SideDrawerContext } from "./SideDrawer";
import { getParams } from "../helpers";
import { handle } from "../helpers/logging";
import { HotKeys } from "react-hotkeys";
import { keyMap } from "../helpers/keyMap";

import { Document, Page, pdfjs } from "react-pdf";
// tslint:disable-next-line:max-line-length
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export interface PDFViewerProps {
  url: string;
}

export interface PDFViewerState {
  numPages: null | number;
  pageNumber: number;
  // Should equal 70vw on desktops, 100vw on mobile
  maxWidth: number;
  wordhoardIDs: string[];
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

export const LoadingComponent = () => (
  <div className="PDFViewer__loading">
    <FontAwesomeIcon icon={faSpinner} size="6x" spin />
  </div>
);

const PDFViewer = (props: PDFViewerProps) => {
  const [pageNumber, setPageNumber] = React.useState<number>(0);
  const [docRef, setDocRef] = React.useState<any>(null);
  const [numPages, setNumPages] = React.useState<number>(0);
  const [maxWidth] = React.useState<number>(calcMaxWidth(window.innerWidth));
  const [showButtons, setShowButtons] = React.useState<boolean>(false);
  const drawer = React.useContext(SideDrawerContext);
  const pdfWrapper = React.createRef<HTMLInputElement>();

  const handlePreviousPage = () => {
    if (pageNumber === 1) {
      return;
    }
    setPageNumber(pageNumber - 1);
  };

  const handleNextPage = () => {
    if (numPages === pageNumber) {
      return;
    }
    setPageNumber(pageNumber + 1);
  };

  const { currentSearchTerm } = getParams();

  const onDocumentLoadSuccess = (e: OnLoadSuccessType) => {
    setNumPages(e.numPages);
    setPageNumber(1);
    setShowButtons(true);
  };

  const PDFErrorComponent = (error: any) => {
    handle(error);
    return (
      <div className="PDFViewer__error">
        <p>De PDF kan niet worden geladen.</p>
        <a href={props.url} download>
          Download het bestand.
        </a>
        {/* If the PDF does not render, show the plaintext */}
        <pre>{JSON.stringify(error, null, 2)}</pre>
      </div>
    );
  };

  const highlightPattern = (text: string, pattern: string): React.ReactNode => {
    const patternPlaceholder = pattern
      .replace(/[\s\-－﹣֊᐀‐–︲—﹘―⸺⸻⸗⹀〜゠⸚]+/g, "%")
      .replace(/[^\w\d%]/g, "");
    const patternRewrite = escapeRegExp(patternPlaceholder).replace(
      /%/g,
      "[\\s\\-－﹣֊᐀‐–︲—﹘―⸺⸻⸗⹀〜゠⸚]+",
    );
    const safePattern = new RegExp(patternRewrite, "gui");
    const splitText = text.split(safePattern);

    if (splitText.length <= 1) {
      return text;
    }

    const matches = text.match(safePattern);

    const whatever = splitText.reduce<React.ReactNode[]>(
      (arr, element, index) => {
        if (matches && matches[index]) {
          return [
            ...arr,
            element,
            <mark key={`mark-${index}`}>{matches[index]}</mark>,
          ];
        }
        return [...arr, element];
      },
      [],
    );

    return <React.Fragment>{whatever}</React.Fragment>;
  };

  const setFillWidth = () => {
    if (docRef !== null) {
      const docRatio = docRef.clientWidth / docRef.clientHeight;
      const newWidth = window.innerHeight * docRatio;
      if (newWidth < maxWidth) {
        drawer.setWidth(newWidth);
      } else {
        drawer.setWidth(maxWidth);
      }
      setTimeout(
        () =>
          docRef.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        100,
      );
    }
  };

  const makeTextRenderer = (searchText: string) => (textItem: TextLayerItem) =>
    highlightPattern(textItem.str, searchText);

  const keyHandlers = {
    PREVIOUS: handlePreviousPage,
    NEXT: handleNextPage,
    FULLSCREEN: setFillWidth,
  };

  // replace "https://api1.ibabs.eu/publicdownload.aspx" with "/ibabs"
  const urlProxy = props.url.replace(
    "https://api1.ibabs.eu/publicdownload.aspx",
    "/ibabs",
  );

  return (
    <HotKeys
      allowChanges={true}
      keyMap={keyMap}
      handlers={keyHandlers}
      ref={() => pdfWrapper}
    >
      <div className="PDFViewer" id="PDFViewer">
        <div className="PDFViewer__scroller">
          {/* This component catches focus on Opening and deals with keys */}
          <div
            id="pdfWrapper"
            tabIndex={-1}
            style={{ width: "100%" }}
            ref={pdfWrapper}
          >
            <Document
              error={<PDFErrorComponent />}
              // file={urlProxy}
              file={urlProxy}
              loading={<LoadingComponent />}
              inputRef={(ref: any) => {
                setDocRef(ref);
              }}
              onLoadSuccess={onDocumentLoadSuccess}
            >
              <Page
                loading={<LoadingComponent />}
                error={<PDFErrorComponent />}
                pageIndex={pageNumber - 1}
                width={drawer.width}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                // customTextRenderer={
                //   currentSearchTerm && makeTextRenderer(currentSearchTerm)
                // }
              />
            </Document>
          </div>
        </div>
        {showButtons && (
          <div className="PDFViewer__button-bar">
            <div className="PDFViewer__button-bar-inner">
              <Button
                onClick={handlePreviousPage}
                disabled={pageNumber === 1}
                title="Vorige pagina (←)"
              >
                <FontAwesomeIcon icon={faArrowLeft} />
              </Button>
              <span>{`${pageNumber} / ${numPages}`}</span>
              <Button
                onClick={handleNextPage}
                disabled={pageNumber === numPages}
                title="Volgende pagina (→)"
              >
                <FontAwesomeIcon icon={faArrowRight} />
              </Button>
              <Button
                onClick={() => window.open(props.url)}
                title="Download bestand (D)"
              >
                <FontAwesomeIcon icon={faDownload} />
              </Button>
              <Button onClick={setFillWidth} title="Scherm vullen (F)">
                <FontAwesomeIcon icon={faExpand} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </HotKeys>
  );
};

export default PDFViewer;
