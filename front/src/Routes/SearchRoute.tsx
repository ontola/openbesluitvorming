import * as React from "react";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import NavBar from "../Components/NavBar";

export interface SearchRouteProps {
}

const SearchRoute = (props: SearchRouteProps) => {
  const [showFilters, setShowFilters] = React.useState(false);

  return (
    <div className="SearchApp">
      <NavBar/>
      <div className="Wrapper">
        <div
          style={{
            display: showFilters ? "block" : "none",
          }}
          className="LeftBar"
        >
          <Filtersbar/>
        </div>
        <div className="RightBar">
          <button
            onClick={() => setShowFilters(!showFilters)}
          >
            Filters {showFilters ? "verbergen" : "tonen"}
          </button>
          <ResultsList/>
        </div>
      </div>
    </div>
  );
};

export default SearchRoute;
