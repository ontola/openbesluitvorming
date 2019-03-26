import * as React from "react";
import { Link } from "react-router-dom";

const Home = () => {
  return (
    <div className="NavBar__top">
      <Link
        to="/"
        title="Homepage"
        className="Logo"
      >
        <span className="Logo__first">Open</span>
        <span>Raadsinformatie</span>
      </Link>
      <a
        href="https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie"
        title="Projectwebsite van VNG Realisatie"
        className="NavBar__link"
      >
        <span>over project</span>
      </a>
      <a
        href="http://docs.openraadsinformatie.nl/"
        className="NavBar__link"
        title="Documentatie van de Open Raadsinformatie API"
        >
        <span>API docs</span>
      </a>
      <a
        href="https://github.com/ontola/ori-search/"
        className="NavBar__link"
        title="Broncode van deze zoekmachine"
      >
        <span>github</span>
      </a>
    </div>
  );
};

export default Home;
