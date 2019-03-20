import * as React from 'react';
import SearchBar from './SearchBar';
import { Link } from 'react-router-dom';

interface NavBarProps {
}

const NavBar: React.FunctionComponent<NavBarProps> = (props) => {
  return (
    <div className="NavBar">
      <Link to="/" className="Logo">
        <span className="Logo__first">Open</span>
        <span>Raadsinformatie</span>
      </Link>
      <SearchBar/>
      {/* tslint:disable-next-line:max-line-length */}
      <a href="https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie" className="NavBar__link">
        <span>over</span>
      </a>
      <a href="http://docs.openraadsinformatie.nl/" className="NavBar__link">
        <span>docs</span>
      </a>
      <a href="https://github.com/openstate/open-raadsinformatie/" className="NavBar__link">
        <span>github</span>
      </a>
    </div>
  );
};

export default NavBar;
