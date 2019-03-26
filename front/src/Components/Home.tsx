import * as React from "react";

export interface HomeProps {
}

const Home = (props: HomeProps) => {
  return (
    <div className="Home">
      <div className="Home__wrapper">
        <h2>Doorzoek vergaderingen van gemeenteraden</h2>
        <p>
          Met deze app zoek je snel door alle openbare raadsinformatie van
          meer dan 100 deelnemende gemeenten
        </p>
        <h2>Over Open Raadsinformatie</h2>
        <p>
          Open Raadsinformatie is een initiatief om de besluitvorming van Nederlandse gemeenten
          transparanter te maken.
          Dit wordt gedaan door automatisch uit de bestaande vergadersoftware
          (raadsinformatiesystemen) van gemeenten de vergaderingen en documenten te halen en
          deze vervolgens middels een API te ontsluiten op een gestandaardiseerde manier.
        </p>
        <p>
          Dit project is gestart door de Open State Foundation en overgenomen door
          VNG Realisatie. De techniek wordt ontwikkeld door Argu en Ontola.
          De broncode van zowel deze zoekmachine als de server van Open Raadsinformatie
          staan open source beschikbaar op Github.
        </p>
        <h2>Deelnemen</h2>
        <p>
          Als je wil dat jouw gemeente aansluit op Open Raadsinformatie,
          vraag dan de griffie van je gemeenteraad om een mail te sturen naar
          {" "}
          <a href="mailto:tom.kunzler@vng.nl">Tom Kunzler</a>.
        </p>
        <h2>Feedback</h2>
        <p>
          Technische vragen of suggesties over de API kunnen op de Issue tracker van de ORI
          achterkant worden geplaatst.
          Voor suggesties, problemen of vragen over deze zoekmachine, plaats een issue op Github.
        </p>
      </div>
    </div>
  );
};

export default Home;
