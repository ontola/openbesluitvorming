import * as React from "react";
import paths from "../paths";

const Home = () => {
  return (
    <div className="Home">
      <div className="Home__wrapper">
      <h1 className="Home__header">Doorzoek vergaderstukken van gemeenteraden</h1>
        <p>
          Met deze app zoek je snel door de openbare vergaderingen, agendapunten, moties en
          documenten van meer dan 100 deelnemende gemeenten.
        </p>
        <p>
          Open Raadsinformatie is een initiatief om de besluitvorming van Nederlandse gemeenten
          transparanter te maken.
          Dit wordt gedaan door automatisch uit de bestaande vergadersoftware
          (raadsinformatiesystemen) van gemeenten de vergaderingen en documenten te halen en
          deze vervolgens middels een API te ontsluiten op een gestandaardiseerde manier.
        </p>
        <h2>Door wie</h2>
        <p>
          Dit project is gestart door
          de <a href={paths.openstate}>Open State Foundation</a> en
          overgenomen door <a href={paths.vngProject}>VNG Realisatie</a>.
          De techniek wordt ontwikkeld
          door <a href={paths.ontola}>Ontola</a>; het team
          achter <a href={paths.argu}>Argu</a>.
          De broncode van zowel deze <a href={paths.oriSearchGithub}>zoekmachine</a> als
          de <a href={paths.oriBackEndGithub}>server</a> van Open Raadsinformatie
          staan open source beschikbaar op Github.
        </p>
        <h2>Data</h2>
        <p>
          Deze zoekmachine maakt gebruik van de Open Raadsinformatie API.
          Als je zelf ook gebruik wil maken van deze data, lees dan
          de <a href={paths.apiDocs}>documentatie</a>.
        </p>
        <h2>Gemeente toevoegen</h2>
        <p>
          Als je wil dat ook jouw gemeente aangesloten wordt op Open Raadsinformatie,
          vraag dan de griffie van je gemeenteraad om een mail te sturen naar
          {" "}
          <a href={paths.projectMail}>Tom Kunzler</a>.
        </p>
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
