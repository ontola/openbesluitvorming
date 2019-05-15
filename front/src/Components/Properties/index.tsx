import LRS from "../../LRS";

/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */
import Title from "./Title";

function register() {
  LRS.registerAll(
    ...Title,
  );
}

register();
