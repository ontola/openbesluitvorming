import { register, RegistrableComponent } from "link-redux";
import React from "react";

import { NS } from "../../LRS";
import { predicateLabelTopology } from "../Topologies/PredicateLabel";
import { ThingProps } from './Thing';
import { SomeTerm } from "@ontologies/core";

interface ThingPredicateLabelProps extends ThingProps {
  label: SomeTerm;
}

/** A Thing inside the Resource or Labels topology */
// TODO: Render a link if there is no property value
const ThingPredicateLabel: RegistrableComponent<ThingPredicateLabelProps> = (props) => {

  const predicateURL = props.subject.value;
  // As a fallback, use part of the predicate URL as a label
  let labelString = predicateURL.substr(predicateURL.lastIndexOf("/") + 1);

  // But if the ontology has an RDF label, that's preferred
  if (props.label !== undefined) {
    labelString = props.label.value;
  }

  return (
    <div className="LabelItem__label" title={predicateURL}>
      {labelString}
    </div>
  );
};

ThingPredicateLabel.type = NS.schema("Thing");
ThingPredicateLabel.topology = predicateLabelTopology
ThingPredicateLabel.mapDataToProps = {
  label: NS.rdfs("label"),
}
ThingPredicateLabel.linkOpts = {
  forceRender: true,
}

export default register(ThingPredicateLabel);
