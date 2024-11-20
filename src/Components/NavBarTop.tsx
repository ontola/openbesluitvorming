import { Link } from "react-router-dom";
import vngLogo from "../vnglogo.svg";
import { IS_ORI } from "../config";

const NavBarTop = () => {
  return (
    <div className="NavBar__top">
      <Link to="/" title="Homepage" className="Logo">
        <span className="Logo__first">Open</span>
        {IS_ORI ? <span>Raadsinformatie</span> : <span>Besluitvorming.nl</span>}
      </Link>
      {
        /* <a
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
      </a> */
      }
      {IS_ORI && (
        <img className="NavBar__vng-logo" src={vngLogo} alt="VNG logo" />
      )}
    </div>
  );
};

export default NavBarTop;
