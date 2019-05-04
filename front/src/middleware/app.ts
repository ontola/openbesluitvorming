/**
 * LinkedRenderStore app middleware
 */

import { MiddlewareActionHandler, MiddlewareWithBoundLRS } from "link-lib";
import { LinkReduxLRSType } from "link-redux";
import { NamedNode, Namespace } from "rdflib";

import { FRONTEND_URL } from "../config";

export const website = FRONTEND_URL;
export const frontendIRI = NamedNode.find(website!);
export const frontendIRIStr = frontendIRI.value;
export const frontendPathname = new URL(frontendIRIStr).pathname;
export const frontendOrigin = new URL(frontendIRIStr).origin;

const app = Namespace(frontendIRIStr.endsWith("/") ? frontendIRIStr : `${frontendIRIStr}/`);
const appSlashless =
  Namespace(frontendIRIStr.slice(0, frontendIRIStr.endsWith("/") ? -1 : undefined));

export const appMiddleware = () => (store: LinkReduxLRSType): MiddlewareWithBoundLRS => {
  (store as any).actions.app = {};

  // eslint-disable-next-line no-param-reassign
  store.namespaces.app = app;
  // eslint-disable-next-line no-param-reassign
  store.namespaces.appSlashless = appSlashless;

  return (next: MiddlewareActionHandler) => (iri: NamedNode, opts: any): Promise<any> => {

    switch (iri) {
      default:
    }

    return next(iri, opts);
  };
};
