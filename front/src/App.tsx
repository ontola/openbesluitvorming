import { createBrowserHistory } from "history";
import { RenderStoreProvider } from "link-redux";
import React, { Component } from "react";
import { Router } from "react-router";

import SearchRoute from "./Routes/SearchRoute";
import "./App.scss";
import LRS from "./LRS";

class App extends Component {
  render() {
    return (
      <RenderStoreProvider value={LRS}>
        <Router history={createBrowserHistory()}>
          <SearchRoute />
        </Router>
      </RenderStoreProvider>
    );
  }
}

export default App;
