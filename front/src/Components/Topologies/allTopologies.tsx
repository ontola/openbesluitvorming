import { boxTopology } from './BoxTopology';
import { labelsTopology } from "./LabelsTopology";
import { predicateLabelTopology } from "./PredicateLabel";
import { propertyValueTopology } from './PropertyValueTopology';
import { resourceTopology } from "./ResourceTopology";

const allTopologies = [
  undefined,
  boxTopology,
  labelsTopology,
  predicateLabelTopology,
  propertyValueTopology,
  resourceTopology,
];

export default allTopologies;
