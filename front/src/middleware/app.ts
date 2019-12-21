/**
 * LinkedRenderStore app middleware
 */

import { createActionPair } from '@ontola/mash';
import rdfFactory, { NamedNode, createNS } from "@ontologies/core";
import { History } from "history";
import { MiddlewareActionHandler, MiddlewareWithBoundLRS } from "link-lib";
import { LinkReduxLRSType } from "link-redux";

import { FRONTEND_URL } from "../config";

export const website = FRONTEND_URL;
export const frontendIRI = rdfFactory.namedNode(website);
export const frontendIRIStr = frontendIRI.value;
export const frontendPathname = new URL(frontendIRIStr).pathname;
export const frontendOrigin = new URL(frontendIRIStr).origin;

const app = createNS(frontendIRIStr.endsWith("/") ? frontendIRIStr : `${frontendIRIStr}/`);
const appSlashless =
  createNS(frontendIRIStr.slice(0, frontendIRIStr.endsWith("/") ? -1 : undefined));

interface AppParams {
  location: NamedNode;
}

export const appMiddleware = (history: History) =>
  (store: LinkReduxLRSType): MiddlewareWithBoundLRS => {
    (store as any).actions.app = {};

    const { dispatch, parse } = createActionPair<AppParams>(app, store);

    // eslint-disable-next-line no-param-reassign
    store.namespaces.app = app;
    // eslint-disable-next-line no-param-reassign
    store.namespaces.appSlashless = appSlashless;

    // BoundActionCreators
    (store as any).actions.app.showResource = (resource: NamedNode) =>
      dispatch('actions/showResource', { location: resource });

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

      const { base, params } = parse(iri)

      switch (base.value) {
        case store.namespaces.app("actions/showResource").value: {
          const currentURL = new URL(currentPath(), frontendOrigin);
          if (params.location) {
            currentURL.searchParams.set("showResource", encodeURIComponent(params.location.value));
          } else {
            throw new Error("No location in URL")
          }
          history.push(retrievePath(currentURL.toString()));

          return Promise.resolve();
        }
        default: {
          return next(iri, opts);
        }
      }
    };
  };
