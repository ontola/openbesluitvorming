import React from "react";
import { Map, TileLayer, useLeaflet } from "react-leaflet";
import { LatLngExpression, LatLngBoundsLiteral, Map as Maptype } from "leaflet";
import "leaflet/dist/leaflet.css";
import { ReactiveComponent } from "@appbaseio/reactivesearch";
import { ids } from "../helpers";

const utrecht: LatLngExpression = [52.0871617, 5.1427243];

export const demoCoordinates: LatLngBoundsLiteral = [
  [4.909515380859374, 52.166351306514414],
  [5.175933837890625, 51.978959373192446],
];

const geoFilter = (coordinates: LatLngBoundsLiteral) => {
  return {
    geo_shape: {
      neighborhood_polygons: {
        shape: {
          type: "envelope",
          coordinates,
        },
        relation: "intersects",
      },
    },
  };
};
const Button = (props: any) => {
  const cntx = useLeaflet();
  const map = cntx.map as Maptype;

  return (
    <button
      className="Button Button__default"
      style={{
        position: "absolute",
        zIndex: 1000,
        bottom: ".5rem",
        left: ".5rem",
      }}
      title="Zoek items die plaatsen noemen die binnen de huidige kaartweergave vallen."
      onClick={() => {
        const bounds = map.getBounds();
        const nw = bounds.getNorthWest();
        const se = bounds.getSouthEast();

        const coordinates: LatLngBoundsLiteral = [
          // Lat & lon values are stored inverted in ORI API
          [nw.lng, nw.lat],
          [se.lng, se.lat],
        ];

        return props.setQuery({
          query: geoFilter(coordinates),
          // TODO: Not working properly, even if the `coordanites` value is added here.
          value: "kaart",
        });
      }}
    >
      Zoek binnen kaart
    </button>
  );
};

const MapComp = (props: any) => (
  <Map
    center={utrecht}
    zoom={7}
    style={{
      height: "200px",
      marginBottom: "1rem",
    }}
  >
    <TileLayer
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
    />
    <Button setQuery={props.setQuery} />
  </Map>
);

/** A custom Filter that uses Waaroverheid Geo Coordinates */
const MapFilter = () => {
  return (
    <ReactiveComponent
      URLParams={true}
      defaultQuery={() => geoFilter}
      componentId={ids.location}
      render={MapComp}
    />
  );
};

export default MapFilter;
