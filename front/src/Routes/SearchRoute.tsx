import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";
import ReactCSSTransitionGroup from "react-addons-css-transition-group";

import Button from "../Components/Button";
import Filtersbar from "../Components/FiltersBar";
import Home from "../Components/Home";
import NavBarTop from "../Components/NavBarTop";
import ResultsList from "../Components/ResultsList";
import PDFViewer from "../Components/PDFViewer";
import { getParams } from "../helpers";
import SearchBar from "../Components/SearchBar";
import { ReactiveBase } from "@appbaseio/reactivesearch";
import theme from "../theme";
import { PORT } from "../config";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const {
    currentDocument,
    currentSearchTerm,
    gemeente,
  } = getParams(props.history);

  const showResults = () => {
    return (currentSearchTerm || gemeente);
  };

  const setSearchParams = (newURL: string) => {
    const url = new URL(newURL);
    props.history.push(url.toString().substring(url.origin.length));
  };

  const apiURL = new URL(window.location.origin);
  apiURL.port = process.env.NODE_ENV === "production" ? "80" : PORT.toString();
  apiURL.pathname = "/api";

  return (
    <ReactiveBase
      theme={theme}
      app="ori_*"
      url={apiURL.toString()}
      setSearchParams={setSearchParams as () => string}
    >
      <div className={`SearchRoute ${showResults() ? "" : "SearchRoute--home"}`}>
        <div className="NavBar">
          <NavBarTop />
          <div className="NavBar__bottom">
            <SearchBar/>
            {showResults() && <Button
              className="SearchBar__button"
              onClick={() => setShowFilters(!showFilters)}
              >
              filters {showFilters ? "verbergen" : "tonen"}
            </Button>}
          </div>
        </div>
        <div className="Wrapper">
          {showResults() &&
            <Filtersbar
              display={showFilters}
            />
          }
          {showResults() &&
            <div className="ResultsBar">
              <div className="Results" id="Results">
                <ResultsList/>
              </div>
            </div>
          }
          {!showResults() &&
            <Home />
          }
          <ReactCSSTransitionGroup
            transitionName="ResourceBar"
            transitionEnterTimeout={200}
            transitionLeaveTimeout={200}
          >
            {currentDocument &&
              <div className="ResourceBar">
                <PDFViewer
                  url={currentDocument}
                  searchTerm={currentSearchTerm}
                />
              </div>
            }
          </ReactCSSTransitionGroup>
        </div>
      </div>
    </ReactiveBase>
  );
};

export default withRouter(SearchRoute);
