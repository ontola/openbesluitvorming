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
        </p>
        <h2>Zoektips</h2>
        <p>
          Open de filters om per gemeente, categorie of datumbereik te zoeken.
        </p>
      </div>
    </div>
  );
};

export default Home;
