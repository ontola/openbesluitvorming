import "./../styles.css";
import "./../admin.css";
import { mount } from "svelte";
import AdminApp from "./AdminApp.svelte";

const target = document.getElementById("admin-app");

if (!target) {
  throw new Error("Admin root #admin-app niet gevonden.");
}

mount(AdminApp, {
  target,
});
