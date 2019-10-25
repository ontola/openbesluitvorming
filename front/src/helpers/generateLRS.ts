/* eslint no-console: 0 */
import {
  createStore,
  DataProcessor,
  MiddlewareFn,
  RDFStore,
  RequestInitGenerator,
  rdflib,
} from "link-lib";
import rdfFactory, {
  NamedNode,
  Node,
  SomeTerm,
  createNS,
  LowLevelStore
} from "@ontologies/core"
import { ReactType } from "react";

import { FRONTEND_ACCEPT, FRONTEND_URL } from "../config";
import transformers from "./transformers";
import { appMiddleware, website } from "../middleware/app";
import logging from "../middleware/logging";
import { handle } from "./logging";
import history from "./history";

(rdflib.RDFFetcher as any).crossSiteProxyTemplate = `${FRONTEND_URL}proxy?iri={uri}`;

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
      _formula: LowLevelStore | undefined,
      subj: Node,
      _pred: NamedNode,
      _obj?: SomeTerm,
      _why?: Node,
    ) => {
      (LRS as any).store.store.add(subj, NS.rdf("type"), NS.rdf("List"));
      return false;
    },
  );

  if (!website) {
    handle(new Error("No website in head"));
  }

  // @ts-ignore TS2341
  LRS.api.accept.default = FRONTEND_ACCEPT;

  LRS.namespaces.aod = createNS("https://argu.co/ns/od#");
  LRS.namespaces.dcterms = createNS("http://purl.org/dc/terms/");
  LRS.namespaces.fa4 = createNS("http://fontawesome.io/icon/");
  LRS.namespaces.foaf = createNS("http://xmlns.com/foaf/0.1/");
  LRS.namespaces.meeting = createNS("https://argu.co/ns/meeting/");
  LRS.namespaces.meta = createNS("https://argu.co/ns/meta#");
  LRS.namespaces.ncal = createNS("http://www.semanticdesktop.org/ontologies/2007/04/02/ncal#");
  LRS.namespaces.opengov = createNS("http://www.w3.org/ns/opengov#");
  LRS.namespaces.org = createNS("http://www.w3.org/ns/org#");
  LRS.namespaces.person = createNS("http://www.w3.org/ns/person#");
  LRS.namespaces.prov = createNS("http://www.w3.org/ns/prov#");
  LRS.namespaces.rdfs = createNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#");
  LRS.namespaces.sh = createNS("http://www.w3.org/ns/shacl#");
  LRS.namespaces.skos = createNS("http://www.w3.org/2004/02/skos/core#");
  LRS.namespaces.vcard = createNS("http://www.w3.org/2006/vcard/ns#");

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
    _: LowLevelStore,
    __: SomeTerm,
    ___: NamedNode,
    obj: SomeTerm,
    ____: Node,
  ): boolean => {
    if (THING_TYPES.includes(obj as NamedNode)) {
      return false;
    }
    // @ts-ignore TS2341
    LRS.schema.addStatement(rdfFactory.quad(obj, NS.rdfs("subClassOf"), NS.schema("Thing")));
    return false;
  });

  // tslint:disable max-line-length
  const ontologicalClassData = [
    // Everything is a thing. Are these still necessary?
    rdfFactory.quad(NS.schema("Thing"), NS.rdfs("subClassOf"), NS.rdfs("Resource")),
    rdfFactory.quad(NS.owl("Thing"), NS.owl("sameAs"), NS.schema("Thing")),
    rdfFactory.quad(NS.schema("MediaObject"), NS.rdfs("subClassOf"), NS.schema("Thing")),

    rdfFactory.quad(NS.dcterms("isReferencedBy"), NS.rdfs("label"), rdfFactory.literal("Besproken in", languages.nl)),

    rdfFactory.quad(NS.meeting("Meeting"), NS.rdfs("label"), rdfFactory.literal("Vergadering", languages.nl)),
    rdfFactory.quad(NS.meeting("Meeting"), NS.schema("description"), rdfFactory.literal("A meeting is an event where people discuss things and make decisions.", languages.en)),

    rdfFactory.quad(NS.meeting("attachment"), NS.rdfs("label"), rdfFactory.literal("Bijlage", languages.nl)),
    rdfFactory.quad(NS.meeting("agenda"), NS.rdfs("label"), rdfFactory.literal("Agendapunten", languages.nl)),
    rdfFactory.quad(NS.meeting("committee"), NS.rdfs("label"), rdfFactory.literal("Commissie", languages.nl)),

    rdfFactory.quad(NS.meta("collection"), NS.rdfs("label"), rdfFactory.literal("Collectie", languages.nl)),

    rdfFactory.quad(NS.ncal("categories"), NS.rdfs("label"), rdfFactory.literal("Categorieën", languages.nl)),

    rdfFactory.quad(NS.org("memberOf"), NS.rdfs("label"), rdfFactory.literal("Lid van", languages.nl)),
    rdfFactory.quad(NS.org("member"), NS.rdfs("label"), rdfFactory.literal("Lid", languages.nl)),
    rdfFactory.quad(NS.org("role"), NS.rdfs("label"), rdfFactory.literal("Rol", languages.nl)),
    rdfFactory.quad(NS.org("organization"), NS.rdfs("label"), rdfFactory.literal("Organisatie", languages.nl)),
    rdfFactory.quad(NS.org("subOrganizationOf"), NS.rdfs("label"), rdfFactory.literal("Valt onder", languages.nl)),

    // RDF:nil is a List, and it should not render.
    rdfFactory.quad(NS.rdf("nil"), NS.rdf("type"), NS.rdf("List")),

    rdfFactory.quad(NS.rdfs("first"), NS.rdfs("label"), rdfFactory.literal("Eerste van de lijst", languages.nl)),
    rdfFactory.quad(NS.rdfs("rest"), NS.rdfs("label"), rdfFactory.literal("Rest van de lijst", languages.nl)),

    rdfFactory.quad(NS.schema("Thing"), NS.rdf("type"), NS.rdfs("Class")),
    rdfFactory.quad(NS.schema("Thing"), NS.rdfs("comment"), rdfFactory.literal("The most generic type of item.")),
    rdfFactory.quad(NS.schema("Thing"), NS.rdfs("label"), rdfFactory.literal("Thing", languages.en)),

    rdfFactory.quad(NS.schema("CreativeWork"), NS.rdfs("label"), rdfFactory.literal("Stuk", languages.nl)),
    rdfFactory.quad(NS.schema("CreativeWork"), NS.schema("description"), rdfFactory.literal("Kan van alles zijn.", languages.en)),

    rdfFactory.quad(NS.schema("startDate"), NS.rdfs("label"), rdfFactory.literal("Startdatum", languages.nl)),
    rdfFactory.quad(NS.schema("endDate"), NS.rdfs("label"), rdfFactory.literal("Einddatum", languages.nl)),
    rdfFactory.quad(NS.schema("dateModified"), NS.rdfs("label"), rdfFactory.literal("Bewerkt op", languages.nl)),
    rdfFactory.quad(NS.schema("eventStatus"), NS.rdfs("label"), rdfFactory.literal("Status", languages.nl)),
    rdfFactory.quad(NS.schema("location"), NS.rdfs("label"), rdfFactory.literal("Locatie", languages.nl)),
    rdfFactory.quad(NS.schema("isBasedOn"), NS.rdfs("label"), rdfFactory.literal("Gebaseerd op", languages.nl)),
    rdfFactory.quad(NS.schema("invitee"), NS.rdfs("label"), rdfFactory.literal("Genodigden", languages.nl)),
    rdfFactory.quad(NS.schema("name"), NS.rdfs("label"), rdfFactory.literal("Naam", languages.nl)),
    rdfFactory.quad(NS.schema("organizer"), NS.rdfs("label"), rdfFactory.literal("Georganiseerd door", languages.nl)),
    rdfFactory.quad(NS.schema("description"), NS.rdfs("label"), rdfFactory.literal("Beschrijving", languages.nl)),
    rdfFactory.quad(NS.schema("superEvent"), NS.rdfs("label"), rdfFactory.literal("Besproken in", languages.nl)),

    rdfFactory.quad(NS.vcard("hasOrganizationName"), NS.rdfs("label"), rdfFactory.literal("Organisatie", languages.en)),
  ];
  // tslint:enable max-line-length

  LRS.addOntologySchematics(ontologicalClassData);
  // @ts-ignore TS2341
  LRS.store.addStatements(ontologicalClassData);

  const ontologicalPropertyData = [
    rdfFactory.quad(NS.foaf("name"), NS.owl("sameAs"), NS.schema("name")),
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
