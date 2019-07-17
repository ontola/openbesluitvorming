import React from "react";
import { register } from "link-redux";

import { NS } from "../../LRS";
import { LoadingComponent } from "../PDFViewer";

const Loading = () => {

  return (
    <div className="Resource">
      <LoadingComponent />
    </div>
  );
};

Loading.type = NS.ll("LoadingResource");

export default register(Loading);
