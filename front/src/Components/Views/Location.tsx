import React from 'react';
import { Map, Marker, Popup, TileLayer } from 'react-leaflet';

import { NS } from "../../LRS";
import { register } from 'link-redux';
// import allTopologies from '../Topologies/allTopologies';
import 'leaflet/dist/leaflet.css';
import { Literal } from 'rdflib';

interface LocationProps {
  address: Literal;
  latitude: Literal;
  longitude: Literal;
  schemaName: Literal;
}

const Location = (props: LocationProps) => {
  const position: [number, number] = [
    parseInt(props.latitude.value),
    parseInt(props.longitude.value),
  ];
  return (
    <React.Fragment>
      <h1>{props.schemaName.value}</h1>
      <Map center={position} zoom={13} style={{height: "15rem"}}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; <a href=&quot;http://osm.org/copyright&quot;>OpenStreetMap</a> contributors"
        />
        <Marker position={position}>
          <Popup>SEP is gaaf</Popup>
        </Marker>
      </Map>
      <p>{props.address.value}</p>
    </React.Fragment>
  )
}

Location.mapDataToProps = {
  schemaName: {
    label: NS.schema.name,
  },
  latitude: NS.schema.latitude,
  longitude: NS.schema.longitude,
  address: NS.app("address"),
};
// Location.topology = allTopologies;
Location.type = NS.schema("GeoCoordinates");

export default register(Location);
