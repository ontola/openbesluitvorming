export const NODE_ENV = process.env.NODE_ENV;
export const SERVER_PORT = 8080;
export const FRONTEND_URL = process.env.FRONTEND_URL || "http://ori.argu.co";
export const FRONTEND_ACCEPT = "application/n-quads";
/**
 * Whether the user is visiting at zoek.openraadsinformatie.nl, and not somewhere else.
 * Defaults to true.
 */
export const IS_ORI = false;
export const TITLE = IS_ORI ? "Open Raadsinformatie" : "Open Besluitvorming";
