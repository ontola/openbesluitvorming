/* eslint no-console: 0 */
import {
  createStore,
  DataProcessor,
  MiddlewareFn,
  RDFStore,
  RequestInitGenerator,
} from "link-lib";
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
  const middleware: MiddlewareFn<any>[] = [
    logging(),
    appMiddleware(history),
  ];

  const store = new RDFStore()
  const LRS = createStore<ReactType>({
    api: new DataProcessor({
      requestInitGenerator: new RequestInitGenerator({
        credentials: "omit",
        csrfFieldName: "csrf-token",
        mode: "cors",
        xRequestedWith: "XMLHttpRequest"
      }),
      report: handle,
      store,
    }),
    report: handle,
    store,
  }, middleware);

  (LRS as any).api.fetcher.__proto__.constructor.withCredentials = function () { return false; };

  // Temp fix for performance improvement
  const broadcast = (LRS as any).broadcast;
  (LRS as any).broadcast = () => broadcast(false, 0);

  transformers(LRS).forEach(t =>
    // @ts-ignore TS2341
    LRS.api.registerTransformer(t.transformer, t.mediaTypes, t.acceptValue),
  );

  const NS = LRS.namespaces;

  // Give RDF Lists explicit type (Class) statements
  (LRS as any).store.store.newPropertyAction(
    LRS.namespaces.rdf("first"),
    (
      _formula: Formula | undefined,
      subj: SomeNode,
      _pred: NamedNode,
      _obj?: SomeTerm,
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
  LRS.namespaces.foaf = Namespace("http://xmlns.com/foaf/0.1/");
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
    // Everything is a thing. Are these still necessary?
    new Statement(NS.schema("Thing"), NS.rdfs("subClassOf"), NS.rdfs("Resource")),
    new Statement(NS.owl("Thing"), NS.owl("sameAs"), NS.schema("Thing")),
    new Statement(NS.schema("MediaObject"), NS.rdfs("subClassOf"), NS.schema("Thing")),

    new Statement(NS.dcterms("isReferencedBy"), NS.rdfs("label"), Literal.find("Besproken in", languages.nl)),

    new Statement(NS.meeting("Meeting"), NS.rdfs("label"), Literal.find("Vergadering", languages.nl)),
    new Statement(NS.meeting("Meeting"), NS.schema("description"), Literal.find("A meeting is an event where people discuss things and make decisions.", languages.en)),

    new Statement(NS.meeting("attachment"), NS.rdfs("label"), Literal.find("Bijlage", languages.nl)),
    new Statement(NS.meeting("agenda"), NS.rdfs("label"), Literal.find("Agendapunten", languages.nl)),
    new Statement(NS.meeting("committee"), NS.rdfs("label"), Literal.find("Commissie", languages.nl)),

    new Statement(NS.meta("collection"), NS.rdfs("label"), Literal.find("Collectie", languages.nl)),

    new Statement(NS.ncal("categories"), NS.rdfs("label"), Literal.find("Categorieën", languages.nl)),

    new Statement(NS.org("memberOf"), NS.rdfs("label"), Literal.find("Lid van", languages.nl)),
    new Statement(NS.org("member"), NS.rdfs("label"), Literal.find("Lid", languages.nl)),
    new Statement(NS.org("role"), NS.rdfs("label"), Literal.find("Rol", languages.nl)),
    new Statement(NS.org("organization"), NS.rdfs("label"), Literal.find("Organisatie", languages.nl)),
    new Statement(NS.org("subOrganizationOf"), NS.rdfs("label"), Literal.find("Valt onder", languages.nl)),

    // RDF:nil is a List, and it should not render.
    new Statement(NS.rdf("nil"), NS.rdf("type"), NS.rdf("List")),

    new Statement(NS.rdfs("first"), NS.rdfs("label"), Literal.find("Eerste van de lijst", languages.nl)),
    new Statement(NS.rdfs("rest"), NS.rdfs("label"), Literal.find("Rest van de lijst", languages.nl)),

    new Statement(NS.schema("Thing"), NS.rdf("type"), NS.rdfs("Class")),
    new Statement(NS.schema("Thing"), NS.rdfs("comment"), Literal.find("The most generic type of item.")),
    new Statement(NS.schema("Thing"), NS.rdfs("label"), Literal.find("Thing", languages.en)),

    new Statement(NS.schema("CreativeWork"), NS.rdfs("label"), Literal.find("Stuk", languages.nl)),
    new Statement(NS.schema("CreativeWork"), NS.schema("description"), Literal.find("Kan van alles zijn.", languages.en)),

    new Statement(NS.schema("startDate"), NS.rdfs("label"), Literal.find("Startdatum", languages.nl)),
    new Statement(NS.schema("endDate"), NS.rdfs("label"), Literal.find("Einddatum", languages.nl)),
    new Statement(NS.schema("dateModified"), NS.rdfs("label"), Literal.find("Bewerkt op", languages.nl)),
    new Statement(NS.schema("eventStatus"), NS.rdfs("label"), Literal.find("Status", languages.nl)),
    new Statement(NS.schema("location"), NS.rdfs("label"), Literal.find("Locatie", languages.nl)),
    new Statement(NS.schema("invitee"), NS.rdfs("label"), Literal.find("Genodigden", languages.nl)),
    new Statement(NS.schema("name"), NS.rdfs("label"), Literal.find("Naam", languages.nl)),
    new Statement(NS.schema("organizer"), NS.rdfs("label"), Literal.find("Georganiseerd door", languages.nl)),
    new Statement(NS.schema("description"), NS.rdfs("label"), Literal.find("Beschrijving", languages.nl)),
    new Statement(NS.schema("superEvent"), NS.rdfs("label"), Literal.find("Besproken in", languages.nl)),

    new Statement(NS.vcard("hasOrganizationName"), NS.rdfs("label"), Literal.find("Organisatie", languages.en)),
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
