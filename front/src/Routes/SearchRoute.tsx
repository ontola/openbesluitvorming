import * as React from "react";
import Filtersbar from "../Components/FiltersBar";
import ResultsList from "../Components/ResultsList";
import SearchBar from "../Components/SearchBar";

export interface SearchRouteProps {
}

const SearchRoute = (props: SearchRouteProps) => {
  return (
    <div className="App">
      <SearchBar/>
      <div className="Wrapper">
        <div className="LeftBar">
          <Filtersbar/>
        </div>
        <div className="RightBar">
          <ResultsList/>
        </div>
      </div>
    </div>
  );
};

export default SearchRoute;
