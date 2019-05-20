
/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */
import DateModified from "./DateModified";
import PDF from "./PDF";
import StartDate from "./StartDate";
import Title from "./Title";

export default [
  ...DateModified,
  ...PDF,
  ...StartDate,
  ...Title,
];
