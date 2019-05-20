import React, { useState } from "react";

interface DownloadResourceProps {
  url: string;
}

const DownloadResource: React.FunctionComponent<DownloadResourceProps> = (props) => {

  const [extension, setExtension] = useState("ttl");

  return (
    <div>
      <a href={`${props.url}.${extension}`} download>
        Download data
      </a>
      <span> als </span>
      <select value={extension} onChange={e => setExtension(e.target.value)}>
        <option value="ttl">Turtle</option>
        <option value="nt">N-Triples</option>
        <option value="nq">N-Quads</option>
        <option value="jsonld">JSON-LD</option>
        <option value="rj">RDF+JSON</option>
        <option value="n3">Notation-3</option>
        <option value="rdf">RDF/XML</option>
      </select>
    </div>
  );
};

export default DownloadResource;
