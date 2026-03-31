import "./../styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App root #app niet gevonden.");
}

mount(App, {
  target,
});
