import * as React from "react";
import { Link } from "react-router-dom";
import SearchBar from "../Components/SearchBar";

const HomeRoute = () => {
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
