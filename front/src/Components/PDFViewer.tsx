import React, { useLayoutEffect } from "react";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faArrowLeft,
  faSpinner,
  faDownload,
  faExpand,
} from "@fortawesome/free-solid-svg-icons";
import { withRouter, RouteComponentProps } from "react-router";
import { SideDrawerContext } from "./SideDrawer";
import { getParams } from "../helpers";
import { handle } from "../helpers/logging";
import { HotKeys } from "react-hotkeys";
const { Document, Page, pdfjs } = require("react-pdf");
// tslint:disable-next-line:max-line-length
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.js`;

export interface PDFViewerProps {
  url: string;
}

export interface PDFViewerState {
  numPages: null | number;
  pageNumber: number;
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

export const LoadingComponent = () =>
  <div className="PDFViewer__loading">
    <FontAwesomeIcon icon={faSpinner} size="6x" spin />
  </div>;

const PDFViewer = (props: PDFViewerProps & RouteComponentProps) => {
  const [pageNumber, setPageNumber] = React.useState<number>(1);
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

  const keyHandlers = {
    PREVIOUS: handlePreviousPage,
    NEXT: handleNextPage,
  };

  useLayoutEffect(
    () => {
      focusOnViewer();
    },
  );

  function focusOnViewer() {
    if (docRef !== null) {
      docRef.focus();
    }
  }

  const {
    currentSearchTerm,
  } = getParams(props.history);

  const onDocumentLoadSuccess = (e: OnLoadSuccessType) => {
    setNumPages(e.numPages);
    setPageNumber(1);
    setShowButtons(true);
  };

  const PDFErrorComponent = (error: any) => {
    handle(error);
    return (
      <div className="PDFViewer__error">
        <p>
          De PDF kan niet worden geladen.
        </p>
        <a href={props.url} download >Download het bestand.</a>
      </div>
    );
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

  const setFillWidth = () => {
    if (docRef !== null) {
      const docRatio = docRef.clientWidth / docRef.clientHeight;
      const newWidth =  window.innerHeight * docRatio;
      if (newWidth < maxWidth) {
        drawer.setWidth(newWidth);
      } else {
        drawer.setWidth(maxWidth);
      }
      setTimeout(
        () => docRef.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
        100,
      );
    }
  };

  const makeTextRenderer = (searchText: string) =>
    (textItem: TextLayerItem) => highlightPattern(textItem.str, searchText);

  return (
    <HotKeys
      allowChanges={true}
      handlers={keyHandlers}
      ref={() => pdfWrapper}
    >
      <div className="PDFViewer">
        <div className="PDFViewer__scroller">
          <div
            id="pdfWrapper"
            tabIndex={-1}
            style={{ width: "100%" }}
            ref={pdfWrapper}
          >
            <Document
              error={<PDFErrorComponent/>}
              file={props.url}
              loading={<LoadingComponent/>}
              inputRef={(ref: any) => { setDocRef(ref); }}
              onLoadSuccess={onDocumentLoadSuccess}
            >
              <Page
                loading={<LoadingComponent/>}
                error={<PDFErrorComponent/>}
                pageIndex={pageNumber - 1}
                width={drawer.width}
                customTextRenderer={currentSearchTerm && makeTextRenderer(currentSearchTerm)}
              />
            </Document>
          </div>
        </div>
        {showButtons &&
          <div className="PDFViewer__button-bar">
            <div className="PDFViewer__button-bar-inner">
              <Button
                onClick={handlePreviousPage}
                disabled={(pageNumber === 1)}
                title="Vorige pagina"
              >
                <FontAwesomeIcon icon={faArrowLeft} />
              </Button>
              <span>{`${pageNumber} / ${numPages}`}</span>
              <Button
                onClick={handleNextPage}
                disabled={(pageNumber === (numPages))}
                title="Volgende pagina"
              >
                <FontAwesomeIcon icon={faArrowRight} />
              </Button>
              <Button
                onClick={() => window.open(props.url)}
                title="Download bestand"
              >
                <FontAwesomeIcon icon={faDownload} />
              </Button>
              <Button
                onClick={setFillWidth}
                title="Scherm vullen"
              >
                <FontAwesomeIcon icon={faExpand} />
              </Button>
            </div>
          </div>
        }
      </div>
    </HotKeys>
  );
};

export default withRouter(PDFViewer);
