import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";

import Button from "../Components/Button";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import PDFViewer from "../Components/PDFViewer";
import { getParams } from "../helpers";
import { Link } from "react-router-dom";
import SearchBar from "../Components/SearchBar";
import { ReactiveBase } from "@appbaseio/reactivesearch";
import theme from "../theme";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const {
    currentDocument,
    currentSearchTerm,
  } = getParams(props.history);

  return (
    <ReactiveBase
      theme={theme}
      app="ori_*"
      url="http://localhost:8080/search/"
    >
      <div className="SearchRoute">
        <div className="NavBar">
          <div className="NavBar__top">
            <Link to="/" className="Logo">
              <span className="Logo__first">Open</span>
              <span>Raadsinformatie</span>
            </Link>
            {/* tslint:disable-next-line:max-line-length */}
            <a href="https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie" className="NavBar__link">
              <span>over</span>
            </a>
            <a href="http://docs.openraadsinformatie.nl/" className="NavBar__link">
              <span>docs</span>
            </a>
            <a href="https://github.com/openstate/open-raadsinformatie/" className="NavBar__link">
              <span>github</span>
            </a>
          </div>
          <div className="NavBar__bottom">        <SearchBar/>
            <Button
              className="SearchBar__button"
              onClick={() => setShowFilters(!showFilters)}
              >
              filters {showFilters ? "verbergen" : "tonen"}
            </Button>
          </div>
        </div>
        <div className="Wrapper">
          {showFilters &&
            <Filtersbar setShowFilters={setShowFilters}/>
          }
          <div className="ResultsBar">
            <div className="Results" id="Results">
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
    </ReactiveBase>
  );
};

export default withRouter(SearchRoute);
