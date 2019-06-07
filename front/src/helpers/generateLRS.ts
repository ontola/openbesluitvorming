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
  SomeNode,
} from "rdflib";
import { ReactType } from "react";

import { FRONTEND_ACCEPT, FRONTEND_URL } from "../config";
import transformers from "./transformers";
import { appMiddleware, website } from "../middleware/app";
import logging from "../middleware/logging";
import { handle } from "./logging";
import history from "./history";

(Fetcher as any).crossSiteProxyTemplate = `${FRONTEND_URL}proxy?iri={uri}`;

export default function generateLRS() {
  // tslint:disable-next-line: prefer-array-literal
  const middleware: Array<MiddlewareFn<any>> = [
    logging(),
    appMiddleware(history),
  ];

  const LRS = createStore<ReactType>({ report: handle }, middleware);

  (LRS as any).api.fetcher.__proto__.constructor.withCredentials = function () { return false; };

  // Temp fix for performance improvement
  const broadcast = (LRS as any).broadcast;
  (LRS as any).broadcast = () => broadcast(false, 0);

  transformers(LRS).forEach(t =>
    // @ts-ignore TS2341
    LRS.api.registerTransformer(t.transformer, t.mediaTypes, t.acceptValue),
  );

  // Give RDF Lists explicit type (Class) statements
  (LRS as any).store.store.newPropertyAction(
    LRS.namespaces.rdf("first"),
    (
        _formula: Formula | undefined,
        subj: SomeNode,
        _pred: NamedNode,
        obj?: SomeTerm,
        _why?: Node,
    ) => {
      (LRS as any).store.store.add(subj, NS.rdf.type, NS.rdf.List);
      return false;
    },
  );

  if (!website) {
    handle(new Error("No website in head"));
  }

  // @ts-ignore TS2341
  LRS.api.accept.default = FRONTEND_ACCEPT;

  LRS.namespaces.aod = Namespace("https://argu.co/ns/od#");
  LRS.namespaces.dcterms = Namespace("http://purl.org/dc/terms/");
  LRS.namespaces.fa4 = Namespace("http://fontawesome.io/icon/");
  LRS.namespaces.meeting = Namespace("https://argu.co/ns/meeting/");
  LRS.namespaces.meta = Namespace("https://argu.co/ns/meta#");
  LRS.namespaces.ncal = Namespace("http://www.semanticdesktop.org/ontologies/2007/04/02/ncal#");
  LRS.namespaces.opengov = Namespace("http://www.w3.org/ns/opengov#");
  LRS.namespaces.org = Namespace("http://www.w3.org/ns/org#");
  LRS.namespaces.person = Namespace("http://www.w3.org/ns/person#");
  LRS.namespaces.prov = Namespace("http://www.w3.org/ns/prov#");
  LRS.namespaces.rdfs = Namespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#");
  LRS.namespaces.sh = Namespace("http://www.w3.org/ns/shacl#");
  LRS.namespaces.skos = Namespace("http://www.w3.org/2004/02/skos/core#");
  LRS.namespaces.vcard = Namespace("http://www.w3.org/2006/vcard/ns#");

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

    new Statement(NS.schema("MediaObject"), NS.rdfs("subClassOf"), NS.schema("Thing")),

    new Statement(NS.schema("CreativeWork"), NS.rdfs("label"), Literal.find("Stuk", languages.nl)),
    new Statement(NS.schema("CreativeWork"), NS.schema("description"), Literal.find("Kan van alles zijn.", languages.en)),

    new Statement(NS.meeting("Meeting"), NS.rdfs("label"), Literal.find("Vergadering", languages.nl)),
    new Statement(NS.meeting("Meeting"), NS.schema("description"), Literal.find("A meeting is an event where people discuss things and make decisions.", languages.en)),

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

  (LRS as any).broadcast();
  (window as any).LRS = LRS;

  return {
    LRS,
    NS,
  };
}
