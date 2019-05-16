import LRS from "../../LRS";

/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */
import Thing from "./Thing";
import ErrorComp from "./Error";
import MediaObject from "./MediaObject";

import Properties from "../Properties";

function register() {
  LRS.registerAll(
    ...MediaObject,
    ...ErrorComp,
    ...Thing,
    ...Properties,
  );
}

register();
