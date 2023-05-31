import React, { Component } from "react";
import { Router } from "react-router";
import { Helmet } from "react-helmet";

import SearchRoute from "./Routes/SearchRoute";
import history from "./helpers/history";
import "./App.scss";
import "./Components/Views";
import { IS_ORI } from "./config";

class App extends Component {
  render() {
    return (
      <React.Fragment>
        <Helmet>
          <meta
            property="og:description"
            content="Doorzoek vergaderstukken van meer dan 120 gemeenten en provincies."
          />
          <meta property="og:image" content="/screenshot.png" />
          <meta
            property="og:title"
            content={IS_ORI ? "Open Raadsinformatie" : "OpenBesluitvorming.nl"}
          />
          <meta
            property="og:url"
            content={
              IS_ORI
                ? "https://zoek.openraadsinformatie.nl"
                : "https://openbesluitvorming.nl"
            }
          />
        </Helmet>
        <Router history={history}>
          <SearchRoute />
        </Router>
      </React.Fragment>
    );
  }
}

export default App;
