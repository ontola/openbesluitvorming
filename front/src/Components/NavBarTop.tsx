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
      {/* <a
        href={paths.vngProject}
        title="Projectwebsite van VNG Realisatie"
        className="NavBar__link"
      >
        <span>over project</span>
      </a>
      <a
        href={paths.apiDocs}
        className="NavBar__link"
        title="Documentatie van de Open Raadsinformatie API"
        >
        <span>API docs</span>
      </a>
      <a
        href={paths.oriSearchGithub}
        className="NavBar__link"
        title="Broncode van deze zoekmachine"
      >
        <span>github</span>
      </a> */}
    </div>
  );
};

export default Home;
