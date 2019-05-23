import React, { useState } from "react";

interface DownloadResourceProps {
  url: string;
}

const DownloadResource: React.FunctionComponent<DownloadResourceProps> = (props) => {

  const [extension, setExtension] = useState("ttl");

  return (
    <div className="Downloader">
      <a
        href={`${props.url}.${extension}`}
        target="_blank"
        rel="noopener noreferrer"
        download
      >
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
