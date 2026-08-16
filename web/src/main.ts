import "./../styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { startAnalytics } from "./analytics.ts";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App root #app niet gevonden.");
}

mount(App, {
  target,
});

startAnalytics();
