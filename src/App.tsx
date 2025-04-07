import React, { Component } from "react";
import { Helmet } from "react-helmet";
import { BrowserRouter } from "react-router-dom";
import SearchRoute from "./Routes/SearchRoute.tsx";
import "./App.scss";
import { IS_ORI } from "./config.ts";

const title = IS_ORI ? "Open Raadsinformatie" : "OpenBesluitvorming.nl";

class App extends Component {
  override render() {
    return (
      <React.Fragment>
        <Helmet>
          <title>{title}</title>
          <meta
            property="og:description"
            content="Doorzoek vergaderstukken van meer dan 320 gemeenten, provincies en waterschappen."
          />
          <meta property="og:image" content="/screenshot.png" />
          <meta
            property="og:title"
            content={IS_ORI ? "Open Raadsinformatie" : "OpenBesluitvorming.nl"}
          />
          <meta
            property="og:url"
            content={IS_ORI
              ? "https://zoek.openraadsinformatie.nl"
              : "https://openbesluitvorming.nl"}
          />
        </Helmet>
        <BrowserRouter>
          <SearchRoute />
        </BrowserRouter>
      </React.Fragment>
    );
  }
}

export default App;
