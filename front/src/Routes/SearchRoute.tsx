import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";
import { History } from "history";

import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import NavBar from "../Components/NavBar";
import PDFViewer from "../Components/PDFViewer";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const getCurrentDocument = (history: History) => {
    const urlObject = new URL(window.location.href);
    const params = new URLSearchParams(urlObject.search);
    const showDocumentBase = params.get("showDocument");
    let showDocument = null;
    if (showDocumentBase !== null) {
      showDocument = atob(showDocumentBase);
    }
    return showDocument;
  };

  const closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showDocument");
    props.history.push(`/search?${params.toString()}`);
  };

  const currentDocument = getCurrentDocument(props.history);

  return (
    <div className="SearchRoute">
      <NavBar/>
      <div className="Wrapper">
        <div
          style={{
            display: showFilters ? "block" : "none",
          }}
          className="FilterBar"
        >
          <Filtersbar/>
        </div>
        <div className="ResultsBar">
          <div className="Results">
            <button
              onClick={() => setShowFilters(!showFilters)}
            >
              Filters {showFilters ? "verbergen" : "tonen"}
            </button>
            <ResultsList/>
          </div>
          <div className="Widgets">
            <div className="Widget">
              <h2>Meldingen ontvangen</h2>
              {/* tslint:disable-next-line:max-line-length */}
              <p>Wil je een e-mail ontvangen wanneer er nieuwe items worden geplaatst over duurzaamheid?</p>
            </div>
          </div>
        </div>
        {currentDocument &&
          <div className="ResourceBar">
            <button
              onClick={closeDocument}
            >
              Sluiten
            </button>
            <PDFViewer
              url={currentDocument}
            />
          </div>
        }
      </div>
    </div>
  );
};

export default withRouter(SearchRoute);
