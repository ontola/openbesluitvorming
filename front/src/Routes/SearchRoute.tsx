import * as React from "react";
import { withRouter, RouteComponentProps } from "react-router";
import ReactCSSTransitionGroup from "react-addons-css-transition-group";

import Button from "../Components/Button";
import Filtersbar from "../Components/FiltersBar";
import Home from "../Components/Home";
import NavBarTop from "../Components/NavBarTop";
import ResultsList from "../Components/ResultsList";
import { getParams, getApiURL } from "../helpers";
import SearchBar from "../Components/SearchBar";
import OrganizationSelector from "../Components/OrganizationSelector";
import { ReactiveBase, SelectedFilters } from "@appbaseio/reactivesearch";
import theme from "../theme";
import SideDrawer from "../Components/SideDrawer";
import { LinkedResourceContainer } from "link-redux";
import rdfFactory from "@ontologies/core";
import { GlobalHotKeys } from "react-hotkeys";

import { keyMap } from "../helpers/keyMap";
// import CustomSelectedFilters from '../Components/CustomSelectedFilters';

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const {
    currentResource,
    hasParams,
  } = getParams(props.history);

  const setSearchParams = (newURL: string) => {
    const url = new URL(newURL);
    props.history.push(url.toString().substring(url.origin.length));
  };

  const closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showResource");
    props.history.push(`/search?${params.toString()}`);
  };

  const globalKeyHandlers = {
    CLOSE: closeDocument,
  };

  return (
    <GlobalHotKeys
      keyMap={keyMap}
      handlers={globalKeyHandlers}
    >
      <ReactiveBase
        theme={theme}
        // app={IS_ORI ? "ori_*" : "*"}
        app="*"
        url={getApiURL().toString()}
        setSearchParams={setSearchParams as () => string}
      >
        <div className={
          `SearchRoute ${hasParams ? "SearchRoute--search" : ""}
          ${showFilters ? "SearchRoute--show-filters" : ""}
          `
        }>
          <div className="NavBar">
            <NavBarTop />
            <div className="NavBar__bottom">
              <div className="NavBar__searchbar">
                <SearchBar/>
                {hasParams && <Button
                  className="SearchBar__button"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  filters {showFilters ? "verbergen" : "tonen"}
                </Button>}
              </div>
              {!hasParams &&
                <OrganizationSelector />
              }
            </div>
          </div>
          <div className="Wrapper">
            {hasParams &&
              <Filtersbar
                display={showFilters}
              />
            }
            {hasParams &&
              <div className="Results">
                <SelectedFilters
                  showClearAll={true}
                  className="Filter Filter__current"
                  clearAllLabel="Reset"
                  // render={CustomSelectedFilters}
                />
                <div className="ResultsListWrapper">
                  <ResultsList/>
                </div>
              </div>
            }
            {!hasParams &&
              <Home />
            }
            <ReactCSSTransitionGroup
              transitionName="SideDrawer__wrapper"
              transitionEnterTimeout={200}
              transitionLeaveTimeout={200}
            >
              {currentResource && hasParams &&
                <SideDrawer>
                  <LinkedResourceContainer subject={rdfFactory.namedNode(currentResource)} />
                </SideDrawer>
              }
            </ReactCSSTransitionGroup>
          </div>
        </div>
      </ReactiveBase>
    </GlobalHotKeys>
  );
};

export default withRouter(SearchRoute);
