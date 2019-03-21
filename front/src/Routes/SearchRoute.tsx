import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";

import Button from "../Components/Button";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import NavBar from "../Components/NavBar";
import PDFViewer from "../Components/PDFViewer";
import { getParams } from "../helpers";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

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
