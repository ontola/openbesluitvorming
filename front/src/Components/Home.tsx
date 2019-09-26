import * as React from "react";
import paths from "../paths";

interface AppType {
  name: string;
  description: string;
  url: string;
}

const otherApps: AppType[] = [
  {
    name: "Raadstalk",
    description: "Bekijk trends in wat gemeenten bespreken.",
    url: "https://www.vngrealisatie.nl/producten/raadstalk",
  },
  {
    name: "WaarOverheid",
    description: "Open Raadsinformatie op de kaart.",
    url: "https://waaroverheid.nl",
  },
  {
    name: "1848.nl",
    description: "Volg thema's die worden besproken en ontvang meldingen.",
    url: "https://1848.nl",
  },
]

const Home = () => {
  return (
    <div className="Home">
      <div className="Home__wrapper">
        <h1 className="Home__header">Doorzoek vergaderstukken van gemeenten en provincies</h1>
        <p>
          Met deze app zoek je snel door de openbare vergaderingen, agendapunten, moties en
          documenten van meer dan 110 deelnemende gemeenten en vijf provincies.
        </p>
        <p>
          Open Raadsinformatie is een initiatief om de besluitvorming van Nederlandse overheden
          transparanter te maken.
          Dit wordt gedaan door automatisch uit de bestaande vergadersoftware
          (zoals raadsinformatiesystemen van gemeenten) de vergaderingen en documenten te halen en
          deze vervolgens middels een API te ontsluiten op een gestandaardiseerde manier.
        </p>
        <h2>Door wie</h2>
        <p>
          Vanuit het <a href={paths.actieplan}>actieplan open overheid</a>{" "}
          werkt <a href={paths.vngRealisatie}>VNG Realisatie</a> in samenwerking met
          de <a href={paths.openstate}>Open State Foundation</a> aan
          het openstellen van besluitvorming van gemeenten en provincies als open data.
          Lees <a href={paths.vngProject}>hier</a> meer over het project.
        </p>
        <p>
          De techniek wordt ontwikkeld
          door <a href={paths.ontola}>Ontola</a>; het team
          achter <a href={paths.argu}>Argu</a>.
          De broncode van zowel deze <a href={paths.oriSearchGithub}>zoekmachine</a> als
          de <a href={paths.oriBackEndGithub}>server</a> van Open Raadsinformatie
          staan open source beschikbaar op Github.
        </p>
        <p>
          Deze zoekmachine maakt gebruik van de Open Raadsinformatie API.
          Als je zelf ook gebruik wil maken van deze data, lees dan
          de <a href={paths.apiDocs}>documentatie</a>.
        </p>
        <h2>Jouw gemeente of provincie toevoegen</h2>
        <p>
          Als je wil dat ook jouw lokale overheid aangesloten wordt op Open Raadsinformatie,
          vraag dan de griffie van je gemeenteraad <a href={paths.vngNewForm}>dit formulier</a> in te vullen.
        </p>
        <h2>Andere apps</h2>
        <ul>
          {otherApps.map((app: AppType) => (
            <li key={app.name}>
              <a href={app.url}>{app.name}</a>
              : <span>{app.description}</span>
            </li>
          ))}
          <li>Jouw app hier? <a href={paths.devMail}>Mail ons!</a></li>
        </ul>
        <h2>Feedback</h2>
        <p>
          Technische vragen of suggesties over de API kunnen op
          de <a href={paths.oriBackEndGithub}>Issue tracker</a> van
          de ORI achterkant worden geplaatst.
        </p>
        <p>
          Voor suggesties, problemen of vragen over deze zoekmachine,
          plaats een issue op <a href={paths.oriSearchGithub}>Github</a>.
        </p>
      </div>
    </div>
  );
};

export default Home;
