import LinkDevTools from "@ontola/link-devtools";
import { RenderStoreProvider } from "link-redux";
import React, { Component } from "react";
import { Router } from "react-router";

import SearchRoute from "./Routes/SearchRoute";
import history from "./helpers/history";
import "./App.scss";
import LRS from "./LRS";
import "./Components/Views";

class App extends Component {
  render() {
    return (
      <RenderStoreProvider value={LRS}>
        <Router history={history}>
          <SearchRoute />
        </Router>
      </RenderStoreProvider>
    );
  }
}

export default App;

if (typeof window !== 'undefined') {
  window.LRS = LRS;
  if (typeof (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined') {
    (window as any).dev = new LinkDevTools('');
  }
}
