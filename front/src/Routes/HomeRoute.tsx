import * as React from "react";
import { Link } from "react-router-dom";
import SearchBar from "../Components/SearchBar";

export interface HomeRouteProps {
}

const HomeRoute = (props: HomeRouteProps) => {
  return (
    <div>
      Home.
      <SearchBar/>
      <Link to="/search">
        search
      </Link>
    </div>
  );
};

export default HomeRoute;
