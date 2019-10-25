import { MiddlewareActionHandler, MiddlewareWithBoundLRS } from "link-lib";
import { LinkReduxLRSType } from "link-redux";
import { NamedNode } from "@ontologies/core";

const logging = () => (store: LinkReduxLRSType): MiddlewareWithBoundLRS => {
  (store as any).actions = {};

  /* eslint-disable no-console */
  return (next: MiddlewareActionHandler) => (iri: NamedNode, opts: any): Promise<any> => {
    console.log("Link action:", iri, opts);

    return next(iri, opts);
  };
};

export default logging;
