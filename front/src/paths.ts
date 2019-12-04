const paths = {
  actieplan: "https://www.open-overheid.nl/actieplan-open-overheid-2018-2020-open-moet-het-zijn/",
  appList: "https://github.com/ontola/ori-search/edit/master/front/src/Components/Home.tsx#L10",
  apiDocs: "http://docs.openraadsinformatie.nl/",
  argu: "http://argu.co/",
  devMail: "mailto:joep@ontola.io",
  ontola: "https://ontola.io/nl",
  openstate: "https://openstate.eu/nl",
  oriIdBase: "https://id.openraadsinformatie.nl/",
  oriId: (id: number | string) =>  `${paths.oriIdBase}${id}`,
  oriSearchGithub: "https://github.com/ontola/ori-search/",
  oriBackEndGithub: "https://github.com/openstate/open-raadsinformatie/",
  projectMail: "mailto:sander.bakker@vng.nl",
  arguMail: "mailto:joep@argu.co",
  vngProject: "https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie",
  vngRealisatie: "https://www.vngrealisatie.nl/",
  vngNewForm: "https://formulieren.vngrealisatie.nl/deelname_openraadsinformatie",
};

export default paths;
