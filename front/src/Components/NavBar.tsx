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
    </div>
  );
};

export default NavBar;
