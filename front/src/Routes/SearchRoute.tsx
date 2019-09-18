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
import { NamedNode } from "rdflib";
import { GlobalHotKeys } from "react-hotkeys";

import { keyMap } from "../helpers/keyMap";

const globalKeyHandlers = {
};

const SearchRoute = (props: RouteComponentProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  const {
    currentResource,
    currentSearchTerm,
  } = getParams(props.history);

  const setSearchParams = (newURL: string) => {
    const url = new URL(newURL);
    props.history.push(url.toString().substring(url.origin.length));
  };

  return (
    <GlobalHotKeys
      keyMap={keyMap}
      handlers={globalKeyHandlers}
    >
      <ReactiveBase
        theme={theme}
        app="*"
        url={getApiURL().toString()}
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
              <div className="NavBar__searchbar">
                <SearchBar/>
                {currentSearchTerm && <Button
                  className="SearchBar__button"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  filters {showFilters ? "verbergen" : "tonen"}
                </Button>}
              </div>
              {!currentSearchTerm &&
                <OrganizationSelector />
              }
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
                <SelectedFilters
                  showClearAll={false}
                  className="Filter Filter__current"
                />
                <div className="ResultsListWrapper">
                  <ResultsList/>
                </div>
              </div>
            }
            {!currentSearchTerm &&
              <Home />
            }
            <ReactCSSTransitionGroup
              transitionName="SideDrawer__wrapper"
              transitionEnterTimeout={200}
              transitionLeaveTimeout={200}
            >
              {currentResource && currentSearchTerm &&
                <SideDrawer>
                  <LinkedResourceContainer subject={NamedNode.find(currentResource)} />
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
