// This must be the first line in src/index.js
import "react-app-polyfill/ie11";
import "react-app-polyfill/stable";
import "./polyfill/textencoder";
import React from "react";
import ReactDOM from "react-dom";
import "./index.css";
import App from "./App";
import * as serviceWorker from "./serviceWorker";
(window as any).globalThis = require('globalthis/polyfill')()

ReactDOM.render(<App />, document.getElementById("root"));

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: http://bit.ly/CRA-PWA
serviceWorker.unregister();
