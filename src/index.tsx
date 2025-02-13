// This must be the first line in src/index.js
import "./index.css";
import App from "./App";
import * as serviceWorker from "./serviceWorker";
import "@ungap/global-this";
import ReactDOM from "react-dom";

ReactDOM.render(<App />, document.getElementById("root"));

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: http://bit.ly/CRA-PWA
serviceWorker.unregister();
