import * as React from "react";
import paths from "../paths";
import { SingleList } from "@appbaseio/reactivesearch";
import { filterStyle, MunicipalityLabel } from "./FiltersBar";

const Home = () => {
  return (
    <div className="Home">
      <div className="Home__wrapper">
        <h2>Doorzoek vergaderingen van gemeenteraden</h2>
        <p>
          Met deze app zoek je snel door alle openbare raadsinformatie van
          meer dan 100 deelnemende gemeenten
        </p>
        <h2>Doet jouw gemeente al mee?</h2>
        <SingleList
          componentId="gemeente"
          dataField="_index"
          filterLabel="Gemeenten"
          size={100}
          sortBy="count"
          showRadio={false}
          showCount={true}
          showSearch={true}
          placeholder="Zoek gemeente..."
          showFilter={true}
          URLParams={true}
          style={filterStyle}
          className="Filter"
          loader="Loading ..."
          renderItem={MunicipalityLabel}
          renderError={(error: any) => <div>{error}</div>}
        />
        <h2>Over Open Raadsinformatie</h2>
        <p>
          Open Raadsinformatie is een initiatief om de besluitvorming van Nederlandse gemeenten
          transparanter te maken.
          Dit wordt gedaan door automatisch uit de bestaande vergadersoftware
          (raadsinformatiesystemen) van gemeenten de vergaderingen en documenten te halen en
          deze vervolgens middels een API te ontsluiten op een gestandaardiseerde manier.
        </p>
        <p>
          Dit project is gestart door
          de <a href={paths.openstate}>Open State Foundation</a> en
          overgenomen door <a href={paths.vngProject}>VNG Realisatie</a>.
          De techniek wordt ontwikkeld
          door <a href={paths.ontola}>Ontola</a>, het team dat
          ook <a href={paths.argu}>Argu</a> heeft ontwikkeld.
          De broncode van zowel deze <a href={paths.oriSearchGithub}>zoekmachine</a> als
          de <a href={paths.oriBackEndGithub}>server</a> van Open Raadsinformatie
          staan open source beschikbaar op Github.
        </p>
        <h2>Data hergebruiken</h2>
        <p>
          Deze zoekmachine maakt gebruik van de Open Raadsinformatie API.
          Je kunt hiermee
        </p>
        <h2>Jouw gemeente toevoegen</h2>
        <p>
          Als je wil dat jouw gemeente aangesloten wordt op Open Raadsinformatie,
          vraag dan de griffie van je gemeenteraad om een mail te sturen naar
          {" "}
          <a href={paths.projectMail}>Tom Kunzler</a>.
        </p>
        <h2>Feedback</h2>
        <p>
          Technische vragen of suggesties over de API kunnen op
          de <a href={paths.oriBackEndGithub}>Issue tracker</a> van
          de ORI achterkant worden geplaatst.
          Voor suggesties, problemen of vragen over deze zoekmachine,
          plaats een issue op <a href={paths.oriSearchGithub}>Github</a>.
        </p>
      </div>
    </div>
  );
};

export default Home;
