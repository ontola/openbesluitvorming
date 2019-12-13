import paths from "./paths";

export interface OrgType {
  /** Relative to /public/orglogos/ */
  picture: string;
  url: string;
  name: string;
  toelichting?: string;
}

/** List of the organizations that made this project possible */
export const poweredBy: OrgType[] = [
  {
    name: "Argu",
    url: paths.argu,
    toelichting: "initiatefnemer OpenBesluitvorming.nl",
    picture: "argu.svg",
  },
  {
    name: "Open State Foundation",
    url: paths.openstate,
    toelichting: "initiatiefnemer Open Raadsinformatie & Open Stateninformatie",
    picture: "openstate.svg",
  },
  {
    name: "VNG Realisatie",
    url: "https://www.vngrealisatie.nl/",
    toelichting: "financiering & beheer Open Raadsinformatie",
    picture: "vng.svg",
  },
  {
    name: "Ontola",
    url: paths.ontola,
    toelichting: "softwareontwikkeling & technisch beheer zoekmachine en API",
    picture: "ontola.svg",
  },
  {
    name: "Qollab",
    url: "https://qollab.io",
    toelichting: "softwareontwikkeling WaarOverheid & HierOverheid",
    picture: "qollab.svg",
  },
  {
    name: "SIDN Fonds",
    url: "https://www.sidnfonds.nl/projecten/argu-open-data/",
    toelichting: "financiering Argu Open Data",
    picture: "sidnfonds.png",
  },
  {
    name: "Stimuleringsfonds voor de Journalistiek",
    url: "https://www.svdj.nl/projects/argu-open-data/",
    toelichting: "financiering Argu Open Data",
    picture: "svdj.svg",
  },
  {
    name: "Open Overheid",
    url: paths.actieplan,
    toelichting: "Actieplan Open Overheid, actiepunt Open Besluitvorming",
    picture: "openoverheid.jpg",
  },
  {
    name: "Ministerie van Binnenlandse Zaken",
    url: paths.actieplan,
    toelichting: "initiatiefnemer Open Overheid",
    picture: "bzk.jpg",
  },
  {
    name: "Provincie Utrecht",
    url: "https://www.provincie-utrecht.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "utrecht.png",
  },
  {
    name: "Provincie Noord-Holland",
    url: "https://www.noord-holland.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "noordholland.png",
  },
  {
    name: "Provincie Zuid-Holland",
    url: "https://www.zuid-holland.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "zuidholland.jpg",
  },
  {
    name: "Provincie Flevoland",
    url: "https://www.flevoland.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "flevoland.png",
  },
  {
    name: "Provincie Limburg",
    url: "https://www.limburg.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "limburg.jpg",
  },
  {
    name: "Provincie Overijssel",
    url: "http://www.overijssel.nl/",
    toelichting: "financiering Open Stateninformatie",
    picture: "overijssel.png",
  },
]
