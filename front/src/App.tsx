import React, { Component } from "react";
import { Router, Route } from "react-router";
import { createBrowserHistory } from "history";
import { ReactiveBase } from "@appbaseio/reactivesearch";

import SearchRoute from "./Routes/SearchRoute";
import HomeRoute from "./Routes/HomeRoute";
import "./App.scss";

import theme from "./theme";

class App extends Component {
  render() {
    return (
      <Router history={createBrowserHistory()}>
        <ReactiveBase
          theme={theme}
          app="ori_*"
          url="http://localhost:8080/search/"
        >
          <Route exact path="/" component={HomeRoute} />
          <Route path="/search" component={SearchRoute} />
        </ReactiveBase>
      </Router>
    );
  }
}

export default App;
