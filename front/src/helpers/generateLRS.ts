/* eslint no-console: 0 */
import { createStore, MiddlewareFn } from "link-lib";
import {
  Formula,
  Literal,
  NamedNode,
  Namespace,
  Node,
  SomeTerm,
  Statement,
  Fetcher,
} from "rdflib";
import { ReactType } from "react";

import { FRONTEND_ACCEPT, FRONTEND_URL } from "../config";
import transformers from "./transformers";
import { appMiddleware, website } from "../middleware/app";
import logging from "../middleware/logging";

(Fetcher as any).crossSiteProxyTemplate = `${FRONTEND_URL}proxy?iri={uri}`;

export default function generateLRS() {
  const middleware: Array<MiddlewareFn<any>> = [
    logging(),
    appMiddleware(),
  ];

  const handle = console.log;

  const LRS = createStore<ReactType>({ report: handle }, middleware);
  // (LRS as any).bulkFetch = true;

  (LRS as any).api.fetcher.__proto__.constructor.withCredentials = function() { return false };

  transformers(LRS).forEach((t) =>
// @ts-ignore TS2341
          LRS.api.registerTransformer(t.transformer, t.mediaTypes, t.acceptValue),
  );

  if (!website) {
    handle(new Error("No website in head"));
  }

// @ts-ignore TS2341
  LRS.api.accept.default = FRONTEND_ACCEPT;

  LRS.namespaces.aod = Namespace("https://argu.co/ns/od#");
  LRS.namespaces.meeting = Namespace("https://argu.co/ns/meeting/");
  LRS.namespaces.sh = Namespace("http://www.w3.org/ns/shacl#");
  LRS.namespaces.opengov = Namespace("http://www.w3.org/ns/opengov#");
  LRS.namespaces.org = Namespace("http://www.w3.org/ns/org#");
  LRS.namespaces.person = Namespace("http://www.w3.org/ns/person#");
  LRS.namespaces.fa4 = Namespace("http://fontawesome.io/icon/");

  const NS = LRS.namespaces;

  const languages = {
    en: "en",
    nl: "nl",
  };

  const THING_TYPES = [
    NS.schema("Thing"),
    NS.rdfs("Resource"),
    NS.owl("Thing"),
    NS.link("Document"),
  ];

// @ts-ignore TS2341
  LRS.store.store.newPropertyAction(NS.rdf("type"), (
      _: Formula,
      __: SomeTerm,
      ___: NamedNode,
      obj: SomeTerm,
      ____: Node,
  ): boolean => {
    if (THING_TYPES.includes(obj as NamedNode)) {
      return false;
    }
    // @ts-ignore TS2341
    LRS.schema.addStatement(new Statement(obj, NS.rdfs("subClassOf"), NS.schema("Thing")));
    return false;
  });

// tslint:disable max-line-length
  const ontologicalClassData = [
    new Statement(NS.schema("Thing"), NS.rdfs("subClassOf"), NS.rdfs("Resource")),
    new Statement(NS.owl("Thing"), NS.owl("sameAs"), NS.schema("Thing")),

    new Statement(NS.schema("Thing"), NS.rdf("type"), NS.rdfs("Class")),
    new Statement(NS.schema("Thing"), NS.rdfs("comment"), Literal.find("The most generic type of item.")),
    new Statement(NS.schema("Thing"), NS.rdfs("label"), Literal.find("Thing", languages.en)),
  ];
// tslint:enable max-line-length

  LRS.addOntologySchematics(ontologicalClassData);
// @ts-ignore TS2341
  LRS.store.addStatements(ontologicalClassData);

  const ontologicalPropertyData = [
    new Statement(NS.foaf("name"), NS.owl("sameAs"), NS.schema("name")),
  ];

  LRS.addOntologySchematics(ontologicalPropertyData);
  // @ts-ignore TS2341
  LRS.store.addStatements(ontologicalPropertyData);

  const r = NamedNode.find("https://id.openraadsinformatie.nl/42037");
  // @ts-ignore TS2341
  LRS.store.addStatements([
    new Statement(r, NS.rdf("type"), NS.schema("Thing")),
  ]);
  (LRS as any).broadcast()

  return {
    LRS,
    NS,
  };
}
