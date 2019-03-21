import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";
import { History } from "history";

import Button from "../Components/Button";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import NavBar from "../Components/NavBar";
import PDFViewer from "../Components/PDFViewer";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const getParams = (history: History) => {
    const urlObject = new URL(window.location.href);
    const params = new URLSearchParams(urlObject.search);
    const currentDocumentBase = params.get("showDocument");
    let currentDocument = null;
    if (currentDocumentBase !== null) {
      currentDocument = atob(currentDocumentBase);
    }
    let currentSearchTerm = params.get("searchbox");
    if (currentSearchTerm) {
      currentSearchTerm = currentSearchTerm.substr(1, currentSearchTerm.length - 2);
    }
    return {
      currentDocument,
      currentSearchTerm,
    };
  };

  const {
    currentDocument,
    currentSearchTerm,
  } = getParams(props.history);

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
            <Button
              onClick={() => setShowFilters(!showFilters)}
            >
              Filters {showFilters ? "verbergen" : "tonen"}
            </Button>
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
            <PDFViewer
              url={currentDocument}
              searchTerm={currentSearchTerm}
            />
          </div>
        }
      </div>
    </div>
  );
};

export default withRouter(SearchRoute);
