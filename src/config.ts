export const SERVER_PORT = 8080;
export const FRONTEND_URL = "http://openbesluitvorming.nl";
export const FRONTEND_ACCEPT = "application/n-quads";
export const API = "https://api.openraadsinformatie.nl/v1/elastic";
/**
 * Whether the user is visiting at zoek.openraadsinformatie.nl, and not somewhere else.
 * Defaults to true.
 */
export const IS_ORI = window.location.host.startsWith(
  "zoek.openraadsinformatie",
);
export const TITLE = IS_ORI ? "Open Raadsinformatie" : "OpenBesluitvorming.nl";
