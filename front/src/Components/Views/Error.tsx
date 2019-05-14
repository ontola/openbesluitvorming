import LinkedRenderStore, { RENDER_CLASS_NAME } from "link-lib";
import React from "react";
import { FormattedMessage } from "react-intl";

import ErrorButtonWithFeedback from "../ErrorButtonWithFeedback";

import { NS } from "../../LRS";

// const propTypes = {
//   caughtError: PropTypes.instanceOf(Error),
//   linkRequestStatus: PropTypes.shape({
//     status: PropTypes.number,
//   }),
//   location: PropTypes.shape({
//     pathname: PropTypes.string,
//   }),
//   reloadLinkedObject: PropTypes.func.isRequired,
//   userType: PropTypes.oneOf(["GuestUser", "ConfirmedUser", "UnconfirmedUser"]),
// };

const ErrorCardComp = (props: any) => {
  const { linkRequestStatus } = props;

  return (
    <div>
        <h2>
          {linkRequestStatus}
        </h2>
        <p>{linkRequestStatus}</p>
        <ErrorButtonWithFeedback theme="box" {...props}>
          <FormattedMessage
            defaultMessage="Try again"
            id="https://app.argu.co/i18n/errors/retryButton/label"
          />
        </ErrorButtonWithFeedback>
    </div>
  );
};

export default [
  LinkedRenderStore.registerRenderer(
    ErrorCardComp,
    NS.ll("ErrorResource"),
    RENDER_CLASS_NAME,
  ),
];
