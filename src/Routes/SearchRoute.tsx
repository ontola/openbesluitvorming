import * as React from "react";
import { useNavigate } from "react-router";

import Button from "../Components/Button.tsx";
import Filtersbar from "../Components/FiltersBar.tsx";
import Home from "../Components/Home.tsx";
import NavBarTop from "../Components/NavBarTop.tsx";
import ResultsList from "../Components/ResultsList";
import { getParams } from "../helpers.ts";
import SearchBar from "../Components/SearchBar.tsx";
import OrganizationSelector from "../Components/OrganizationSelector.tsx";
import { ReactiveBase, SelectedFilters } from "@appbaseio/reactivesearch";
import theme from "../theme";
import SideDrawer from "../Components/SideDrawer.tsx";
import { GlobalHotKeys } from "react-hotkeys";

import { keyMap } from "../helpers/keyMap.ts";
import PDFViewer from "../Components/PDFViewer.tsx";
import { API } from "../config.ts";

const SearchRoute = () => {
  const [showFilters, setShowFilters] = React.useState(false);

  const navigate = useNavigate();
  const { currentResource, hasParams } = getParams();

  const setSearchParams = (newURL: string) => {
    const url = new URL(newURL);
    navigate(url.toString().substring(url.origin.length));
  };

  const closeDocument = () => {
    const currentURL = new URL(globalThis.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showResource");
    navigate(`/search?${params.toString()}`);
  };

  const globalKeyHandlers = {
    CLOSE: closeDocument,
  };

  return (
    <GlobalHotKeys keyMap={keyMap} handlers={globalKeyHandlers}>
      <ReactiveBase
        theme={theme}
        // app={IS_ORI ? "ori_*" : "*"}
        app="*"
        url={API}
        setSearchParams={setSearchParams as () => string}
      >
        <div
          className={`SearchRoute ${hasParams ? "SearchRoute--search" : ""}
          ${showFilters ? "SearchRoute--show-filters" : ""}
          `}
        >
          <div className="NavBar">
            <NavBarTop />
            <div className="NavBar__bottom">
              <div className="NavBar__searchbar">
                <SearchBar />
                {hasParams && (
                  <Button
                    className="SearchBar__button"
                    onClick={() => setShowFilters(!showFilters)}
                  >
                    filters {showFilters ? "verbergen" : "tonen"}
                  </Button>
                )}
              </div>
              {!hasParams && <OrganizationSelector />}
            </div>
          </div>
          <div className="Wrapper">
            {hasParams && <Filtersbar display={showFilters} />}
            {hasParams && (
              <div className="Results">
                <SelectedFilters
                  showClearAll={true}
                  className="Filter Filter__current"
                  clearAllLabel="Reset"
                  // render={CustomSelectedFilters}
                />
                <div className="ResultsListWrapper">
                  <ResultsList />
                </div>
              </div>
            )}
            {!hasParams && <Home />}
            {currentResource && hasParams && (
              <SideDrawer>
                <PDFViewer url={currentResource} key={currentResource} />
              </SideDrawer>
            )}
          </div>
        </div>
      </ReactiveBase>
    </GlobalHotKeys>
  );
};

export default SearchRoute;
