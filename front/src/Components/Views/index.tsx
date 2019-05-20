import LRS from "../../LRS";

/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */

import AgendaItem from "./AgendaItem";
import ErrorComp from "./Error";
import Loading from "./Loading";
import MediaObject from "./MediaObject";
import Properties from "../Properties";
import Thing from "./Thing";
import ThingResource from "./ThingResource";

function register() {
  LRS.registerAll(
    ...AgendaItem,
    ...ErrorComp,
    ...Loading,
    ...MediaObject,
    ...Properties,
    ...Thing,
    ...ThingResource,
  );
}

register();
