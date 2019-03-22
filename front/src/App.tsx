import React, { Component } from "react";
import { Router } from "react-router";
import { createBrowserHistory } from "history";

import SearchRoute from "./Routes/SearchRoute";
import "./App.scss";

class App extends Component {
  render() {
    return (
      <Router history={createBrowserHistory()}>
        <SearchRoute />
      </Router>
    );
  }
}

export default App;
