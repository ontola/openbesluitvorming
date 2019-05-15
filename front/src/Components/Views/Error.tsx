import React from "react";
import { FormattedMessage } from "react-intl";

import ErrorButtonWithFeedback from "../ErrorButtonWithFeedback";

import { NS } from "../../LRS";
import { register } from "link-redux";

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
      ERROR!
        <h2>
          {linkRequestStatus.status}
        </h2>
        <ErrorButtonWithFeedback theme="box" {...props}>
          <FormattedMessage
            defaultMessage="Try again"
            id="https://app.argu.co/i18n/errors/retryButton/label"
          />
        </ErrorButtonWithFeedback>
    </div>
  );
};

ErrorCardComp.type = NS.ll("ErrorResource");

export default register(ErrorCardComp);
