import React from "react";
import { register } from "link-redux";

import { NS } from "../../LRS";
import { LoadingWithSpinner } from "../ResultsList";

const Loading = (props: any) => {

  return (
    <div className="Resource">
      <LoadingWithSpinner />
    </div>
  );
};

Loading.type = NS.ll("LoadingResource");

export default register(Loading);
