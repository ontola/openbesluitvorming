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
import Resource from "../Components/Resource";
import SideDrawer from "../Components/SideDrawer";

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const {
    currentDocument,
    currentResource,
    currentSearchTerm,
  } = getParams(props.history);

  const setSearchParams = (newURL: string) => {
    const url = new URL(newURL);
    props.history.push(url.toString().substring(url.origin.length));
  };

  const apiURL = new URL(window.location.origin);
  apiURL.port = PORT.toString();
  apiURL.pathname = "/api";

  return (
    <ReactiveBase
      theme={theme}
      app="ori_*"
      url={apiURL.toString()}
      setSearchParams={setSearchParams as () => string}
    >
      <div className={
        `SearchRoute ${currentSearchTerm ? "SearchRoute--search" : ""}
        ${showFilters ? "SearchRoute--show-filters" : ""}
        `
      }>
        <div className="NavBar">
          <NavBarTop />
          <div className="NavBar__bottom">
            <SearchBar/>
            {currentSearchTerm && <Button
              className="SearchBar__button"
              onClick={() => setShowFilters(!showFilters)}
              >
              filters {showFilters ? "verbergen" : "tonen"}
            </Button>}
          </div>
        </div>
        <div className="Wrapper">
          {currentSearchTerm &&
            <Filtersbar
              display={showFilters}
            />
          }
          {currentSearchTerm &&
            <div className="Results">
              <ResultsList/>
            </div>
          }
          {!currentSearchTerm &&
            <Home />
          }
          <ReactCSSTransitionGroup
            transitionName="ResourceBar"
            transitionEnterTimeout={200}
            transitionLeaveTimeout={200}
          >
            {currentResource &&
              <SideDrawer>
                <Resource url={currentResource} />
              </SideDrawer>
            }
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
