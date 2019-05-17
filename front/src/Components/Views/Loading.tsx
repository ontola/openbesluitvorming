import React from "react";
import { register } from "link-redux";

import { NS } from "../../LRS";

const Loading = (props: any) => {

  return (
    <div className="Resource">
      Loading...
    </div>
  );
};

Loading.type = NS.ll("LoadingResource");

export default register(Loading);
