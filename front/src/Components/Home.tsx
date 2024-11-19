import * as React from "react";
import paths from "../paths";
import { TITLE, IS_ORI } from "../config";
import { poweredBy, OrgType } from "../poweredBy";
import { colors } from "../sharedStyles";
import DocumentCounter from "./DocumentCounter";
import useDocumentCounter from "./DocumentCounter";

interface AppType {
  name: string;
  description: string;
  url: string;
}

const otherApps: AppType[] = [
  // {
  //   name: "Raadstalk",
  //   description: "Bekijk trends in wat gemeenten bespreken.",
  //   url: "https://www.vngrealisatie.nl/producten/raadstalk",
  // },
  // {
  //   name: "WaarOverheid",
  //   description: "Open Raadsinformatie op de kaart.",
  //   url: "https://waaroverheid.nl",
  // },
  {
    name: "1848.nl",
    description: "Volg thema's die worden besproken en ontvang meldingen.",
    url: "https://1848.nl",
  },
  // {
  //   name: "Voordat het nieuws was",
  //   description: "Zoek stukken van de raad en staten bij het laatste nieuws",
  //   url: "https://www.voordathetnieuwswas.nl/",
  // },
];

const Home = () => {
  React.useEffect(() => {
    document.title = TITLE;
  }, []);

  const counter = useDocumentCounter();

  return (
    <div className="Home">
      <div className="Home__wrapper">
        <h1 className="Home__header">
          Doorzoek {counter} vergaderstukken van gemeenten, provincies en
          waterschappen
        </h1>
        {IS_ORI ? (
          <div>
            <p>
              Open Raadsinformatie is een initiatief om de besluitvorming van
              Nederlandse gemeenten transparanter te maken. Dit wordt gedaan
              door automatisch uit de bestaande vergadersoftware
              (raadsinformatiesystemen) de vergaderingen en documenten te halen
              en deze vervolgens middels een API te ontsluiten op een
              gestandaardiseerde manier.
            </p>
            <h2>Door wie</h2>
            <p>
              Vanuit het <a href={paths.actieplan}>actieplan open overheid</a>{" "}
              werkt <a href={paths.vngRealisatie}>VNG Realisatie</a> in
              samenwerking met de{" "}
              <a href={paths.openstate}>Open State Foundation</a> aan het
              openstellen van besluitvorming van gemeenten en provincies als
              open data. Inmiddels is de Wet Open Overheid van kracht en heeft
              VNG het informatiemodel mede in dat licht verder aangescherpt en
              verrijkt in samenwerking met IPO en UvW en ook toepasbaar gemaakt
              voor provincies en waterschappen.
            </p>
            <p>
              De techniek is gemaakt door <a href={paths.ontola}>Ontola</a> en{" "}
              <a href={paths.openstate}>Open State</a>. De broncode van zowel
              deze <a href={paths.oriSearchGithub}>zoekmachine</a> als de{" "}
              <a href={paths.oriBackEndGithub}>server</a> van {TITLE} zijn open
              source beschikbaar op Github.
            </p>
          </div>
        ) : (
          <div>
            <h2>Door wie?</h2>
            <p>
              OpenBesluitvorming.nl is een initiatief om data van gemeenten,
              provincies en andere overheden samen te brengen in één
              zoekomgeving. Zowel deze{" "}
              <a href={paths.oriSearchGithub}>zoekmachine</a> als de{" "}
              <a href={paths.oriBackEndGithub}>server</a> zijn open source.
            </p>
            <p>
              Vanuit het <a href={paths.actieplan}>actieplan open overheid</a>{" "}
              werkt het Ministerie van Binnenlandse Zaken aan het transparanter
              maken van overheden. Actiepunt 1 uit dit plan is het openen van
              besluitvormingsdata. De{" "}
              <a href={paths.openstate}>Open State Foundation</a> is samen met{" "}
              <a href={paths.vngRealisatie}>VNG Realisatie</a> het project{" "}
              <a href={paths.vngProject}>Open Raadsinformatie</a> gestart om
              data uit gemeenteraden te verzamelen. Voor de provincies is Open
              Stateninformatie gestart.
            </p>
            <p>
              Argu heeft als missie om besluitvorming zo open en toegankelijk
              mogelijk te maken. Als technisch ontwikkelaar en beheerder raakte
              Argu betrokken bij deze projecten.
            </p>
          </div>
        )}
        <h2>Toekomst</h2>
        <p>
          Momenteel wordt de laatste hand gelegd aan de laatste versie van de
          ORI API. Documentatie over deze ontwikkeling is op{" "}
          <a href="https://vng-realisatie.github.io/ODS-Open-Raadsinformatie/Informatiemodel">
            GitHub
          </a>{" "}
          na te lezen.
        </p>
        <p>
          Door het gebruik van deze ORI API zullen de bestuursorganen in staat
          zijn deze rijke informatiestroom geautomatiseerd actief openbaar te
          maken in de geest van de Wet Open Overheid en heel specifiek de
          informatiecategorieën 3.3 2a. en 3.3 2c. Aan de andere kant kan elke
          partij zich hierdoor gedragen als hergebruiker en gebruik maken van
          deze rijke collectie.
        </p>
        <p>
          Het uiteindelijke doel is dat PLOOI conform de Common Ground principes
          de data bij de bron zal ophalen middels deze ORI API . Dit stelt PLOOI
          in staat de raadpleegfunctie over te nemen voor deze raadpleegomgeving
          die als overbrugging geldt tot dat moment.
        </p>
        <h2>Voor wie is deze app?</h2>
        <ul>
          <li>
            <b>Ambtenaren</b> zoeken naar hoe andere overheden bepaalde
            problemen oplossen.
          </li>
          <li>
            <b>Ontwikkelaars</b> gaan aan de slag met deze data om eigen apps te
            maken.
          </li>
          <li>
            <b>Betrokken burgers</b> zoeken wat overheden hebben gezegd over een
            bepaald onderwerp.
          </li>
          <li>
            <b>Belangenbehartigers</b> kunnen volgen waar beslissingen over
            (gaan) worden gemaakt.
          </li>
          <li>
            <b>Journalisten</b> zien hoe besluitvorming zich heeft ontwikkeld
            over tijd.
          </li>
        </ul>
        <h2>Jouw gemeente of provincie toevoegen</h2>
        <p>
          Als je wil dat ook jouw gemeente aangesloten wordt op Open
          Raadsinformatie, vraag dan de griffie van je gemeenteraad{" "}
          <a href={paths.vngNewForm}>dit formulier</a> in te vullen.
          {IS_ORI ? null : (
            <span>
              {" "}
              Provincies, waterschappen of andere overheden kunnen mailen naar{" "}
              <a href={paths.ontolaMail}>joep@ontola.io</a>.
            </span>
          )}
        </p>
        <h2>Andere apps gemaakt met deze data</h2>
        <p>
          Alle data (moties, vergaderingen, documenten, agendapunten,
          stukken...) is gratis te gebruiken. Deze zoekmachine is dan ook maar
          één van de apps die is gemaakt met de data:
        </p>
        <ul>
          {otherApps.map((app: AppType) => (
            <li key={app.name}>
              <a href={app.url}>{app.name}</a>: <span>{app.description}</span>
            </li>
          ))}
          <li>
            Jouw app hier? Ga aan de slag met de{" "}
            <a href={paths.apiDocs}>documentatie</a> en{" "}
            <a href={paths.appList}>
              mail <a href={paths.projectMail}>Sander Bakker</a>!
            </a>
          </li>
        </ul>
        <h2>Contact</h2>
        <p>
          Technische vragen of suggesties over de API kunnen op de{" "}
          <a href={paths.oriBackEndGithub}>issue tracker van de server</a>{" "}
          geplaatst worden.
        </p>
        <p>
          Voor suggesties, problemen of vragen over deze zoekmachine, plaats een
          issue op{" "}
          <a href={paths.oriSearchGithub}>de ori-search issue tracker</a>.
        </p>
        <p>
          Voor algemene vragen kunt u mailen naar{" "}
          <a href={IS_ORI ? paths.projectMail : paths.ontolaMail}>
            {IS_ORI ? "Sander Bakker" : "Joep Meindertsma"}
          </a>
        </p>
        <h2>Privacy</h2>
        <p>
          We gebruiken Swetrix (een privacy-vriendelijk alternatief voor Google
          analytics) om bezoekersstatistieken te verzamelen. We gebruiken deze
          gegevens alleen om anonieme rapportages te maken van bezoekers, en
          verkopen deze data aan niemand door. We slaan de laatste zes getallen
          van IP adressen niet op om jouw privacy te beschermen.
        </p>
        <h2>Disclaimer</h2>
        <p>
          De data in deze zoekmachine komt uit Open Raadsinformatie en Open
          Stateninformatie. Deze data is met toestemming van de deelnemende
          gemeenten, provincies en waterschappen geïmporteerd uit diverse
          vergadersystemen. De data kan door het importeren incompleet, onjuist
          of niet up to date zijn. Het eigenaarschap van de data ligt bij de
          organisaties die de data hebben aangemaakt, of de respectievelijke
          auteurs van de documenten.
        </p>
        {IS_ORI ? null : (
          <React.Fragment>
            <p>
              OpenBesluitvorming.nl is tot stand gekomen door de tijd en moeite
              van de onderstaande organisaties. Hover met je muis over de
              logo&apos;s om te zien wat hoe de organisaties hebben bijgedragen,
              en klik er op om er meer over te lezen.
            </p>
          </React.Fragment>
        )}
      </div>
      {IS_ORI ? null : (
        <div
          style={{
            backgroundColor: "white",
            padding: "1rem",
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            marginTop: "2rem",
            flexWrap: "wrap",
            borderTop: "solid 1px",
            borderTopColor: colors.g2,
          }}
        >
          {poweredBy.map((org: OrgType) => (
            <a
              href={org.url}
              key={org.name}
              title={
                org.toelichting ? `${org.name}: ${org.toelichting}` : org.name
              }
              style={{
                display: "flex",
                margin: "1rem",
              }}
            >
              <img
                src={`/orglogos/${org.picture}`}
                alt={org.name}
                style={{
                  minWidth: "2rem",
                  maxWidth: "5rem",
                  maxHeight: "5rem",
                  width: "100%",
                  height: "100%",
                }}
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

export default Home;
