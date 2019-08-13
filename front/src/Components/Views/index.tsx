import LRS from "../../LRS";

/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */

import AgendaItem from "./AgendaItem";
import ErrorComp from "./Error";
import Loading from "./Loading";
import LoadingLabel from "./LoadingLabel";
import MediaObject from "./MediaObject";
import Meeting from "./Meeting";
import Membership from "./Membership";
import Organization from "./Organization";
import Person from "./Person";
import Predicate from "./Predicate";
import Properties from "../Properties";
import RDFList from "./RDFList";
import Thing from "./Thing";
import ThingResource from "./ThingResource";
import ThingPredicateLabel from "./ThingPredicateLabel";

function register() {
  LRS.registerAll(
    ...AgendaItem,
    ...ErrorComp,
    ...Loading,
    ...LoadingLabel,
    ...MediaObject,
    ...Meeting,
    ...Membership,
    ...Organization,
    ...Person,
    ...Predicate,
    ...Properties,
    ...RDFList,
    ...Thing,
    ...ThingResource,
    ...ThingPredicateLabel,
  );
}

register();
