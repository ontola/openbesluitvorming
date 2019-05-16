
/**
 * This document is purely for including all the views into the code.
 * Please properly include each file when access to the code is needed.
 */
import Title from "./Title";
import PDF from "./pdf";
import DateModified from "./dateModified";

export default [
  ...PDF,
  ...Title,
  ...DateModified,
];
