/**
 * LinkedRenderStore app middleware
 */

import { MiddlewareActionHandler, MiddlewareWithBoundLRS } from "link-lib";
import { LinkReduxLRSType } from "link-redux";
import { NamedNode, Namespace } from "rdflib";

import { FRONTEND_URL } from "../config";
import { History } from "history";

export const website = FRONTEND_URL;
export const frontendIRI = NamedNode.find(website!);
export const frontendIRIStr = frontendIRI.value;
export const frontendPathname = new URL(frontendIRIStr).pathname;
export const frontendOrigin = new URL(frontendIRIStr).origin;

const app = Namespace(frontendIRIStr.endsWith("/") ? frontendIRIStr : `${frontendIRIStr}/`);
const appSlashless =
  Namespace(frontendIRIStr.slice(0, frontendIRIStr.endsWith("/") ? -1 : undefined));

export const appMiddleware = (history: History) =>
  (store: LinkReduxLRSType): MiddlewareWithBoundLRS => {
    (store as any).actions.app = {};

    // eslint-disable-next-line no-param-reassign
    store.namespaces.app = app;
    // eslint-disable-next-line no-param-reassign
    store.namespaces.appSlashless = appSlashless;

    // BoundActionCreators
    (store as any).actions.app.showResource = (resource: NamedNode) => {
      const actionIRI = `actions/showResource?location=${encodeURIComponent(resource.value)}`;
      store.exec(store.namespaces.app(actionIRI));
    };

    const currentPath = (): string => {
      const l = history.location;
      return [
        [l.pathname, l.search].filter(Boolean).join(""),
        l.hash,
      ].filter(Boolean).join("#");
    };

    /**
     * Returns only the pathname and beyond. Useful for relative navigation.
     * @param {string} iriString The IRI to process.
     * @returns {undefined|string} The pathname or undefined if invalid.
     */
    const retrievePath = (iriString: string) => {
      // TODO: https://github.com/linkeddata/rdflib.js/issues/265
      const bugNormalized = iriString.replace(`${frontendOrigin}//`, `${frontendOrigin}/`);
      const iri = iriString && new URL(bugNormalized, frontendOrigin);
      return iri && iri.pathname + iri.search + iri.hash;
    };

    // Action Handlers
    return (next: MiddlewareActionHandler) => (iri: NamedNode, opts: any): Promise<any> => {

      switch (iri) {
        default:
      }

      if (iri.value.startsWith(store.namespaces.app("actions/showResource").value)) {
        const resource = new URL(iri.value).searchParams.get("location");

        const currentURL = new URL(currentPath(), frontendOrigin);
        currentURL.searchParams.set("showResource", encodeURIComponent(resource!));
        history.push(retrievePath(currentURL.toString()));
      }

      return next(iri, opts);
    };
  };
