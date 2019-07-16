import React from "react";
import { register } from "link-redux";

import LRS, { NS } from "../../LRS";
import { propertyToArr } from "../../helpers";
import allTopologies from "../Topologies/allTopologies";

interface TextProps {
  text: string[];
}

interface PageProps {
  item: string;
  number: number;
}

const Page = (props: PageProps) =>
  <div className="Text-Page">
    <h2>
      {props.number}
    </h2>
    {props.item}
  </div>;

const Text = (props: TextProps) => {
  return (
    <React.Fragment>
      {propertyToArr(LRS, [], props.text).map(
        (item: string, i: number) => <Page item={item} number={i + 1} />,
      )}
    </React.Fragment>
  );
};

Text.type = NS.schema("Thing");
Text.property = NS.schema.text;
Text.topology = allTopologies;
Text.mapDataToProps = {
  text: {
    label: NS.schema.text,
    limit: 100,
  },
};
Text.linkOpts = {
  returnType: "value",
};

// @ts-ignore
export default register(Text);
