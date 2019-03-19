import React, { Component } from "react";
import { ReactiveBase } from "@appbaseio/reactivesearch";
import "./App.css";
import Filtersbar from "./Components/FiltersBar";
import ResultsList from "./Components/ResultsList";
import SearchBar from "./Components/SearchBar";

class App extends Component {
  render() {
    return (
      <ReactiveBase
        app="ori_*"
        url="http://localhost:8080/search/"
      >
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
      </ReactiveBase>
    );
  }
}

export default App;
