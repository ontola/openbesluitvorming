import HttpStatus from "http-status-codes";
import React from "react";
import { defineMessages, FormattedMessage } from "react-intl";

import { handle } from "./logging";

// tslint:disable max-line-length
const messages: any = defineMessages({
  "400/body": {
    defaultMessage: "The request made cannot be fulfilled because it contains bad syntax, check your URL parameters or refresh the page that linked to this resource.",
    id: "https://app.argu.co/i18n/errors/request/200/body",
  },
  "400/header": {
    defaultMessage: "Bad request (400 Bad Request)",
    id: "https://app.argu.co/i18n/errors/request/200/header",
  },
  "401/body": {
    defaultMessage: "You have to be logged in to view this resource.",
    id: "https://app.argu.co/i18n/errors/request/401/body",
  },
  "401/header": {
    defaultMessage: "Unauthorized",
    id: "https://app.argu.co/i18n/errors/request/401/header",
  },
  "403/body": {
    defaultMessage: "Maybe it's visible after logging in.",
    id: "https://app.argu.co/i18n/errors/request/403/body",
  },
  "403/header": {
    defaultMessage: "This item is hidden",
    id: "https://app.argu.co/i18n/errors/request/403/header",
  },
  "404/body": {
    defaultMessage: "Maybe the item you are looking for is deleted or never existed.",
    id: "https://app.argu.co/i18n/errors/request/404/body",
  },
  "404/header": {
    defaultMessage: "This item is not found",
    id: "https://app.argu.co/i18n/errors/request/404/header",
  },
  "406/body": {
    defaultMessage: "This resource cannot be viewed in the current format.",
    id: "https://app.argu.co/i18n/errors/request/406/body",
  },
  "406/header": {
    defaultMessage: "Not acceptable",
    id: "https://app.argu.co/i18n/errors/request/406/header",
  },
  "408/body": {
    defaultMessage: "The request took too long, refresh the page or try again later.",
    id: "https://app.argu.co/i18n/errors/request/408/body",
  },
  "408/header": {
    defaultMessage: "Request timeout",
    id: "https://app.argu.co/i18n/errors/request/408/header",
  },
  "409/body": {
    defaultMessage: "The change could not be persisted because the resource was edited since it was opened locally.",
    id: "https://app.argu.co/i18n/errors/request/409/body",
  },
  "409/header": {
    defaultMessage: "Conflict",
    id: "https://app.argu.co/i18n/errors/request/409/header",
  },
  "410/body": {
    defaultMessage: "The resource has been deleted permanently.",
    id: "https://app.argu.co/i18n/errors/request/410/body",
  },
  "410/header": {
    defaultMessage: "Gone",
    id: "https://app.argu.co/i18n/errors/request/410/header",
  },
  "413/body": {
    defaultMessage: "The item that you are uploading is too large. Go back and try a smaller file.",
    id: "https://app.argu.co/i18n/errors/request/413/body",
  },
  "413/header": {
    defaultMessage: "Request entity too large (413 Payload Too Large)",
    id: "https://app.argu.co/i18n/errors/request/413/header",
  },
  "422/body": {
    defaultMessage: "The item that you are trying to create cannot be processed.",
    id: "https://app.argu.co/i18n/errors/request/422/body",
  },
  "422/header": {
    defaultMessage: "Unprocessable Entity",
    id: "https://app.argu.co/i18n/errors/request/422/header",
  },
  "429/body": {
    defaultMessage: "You're making too many request, try again in half a minute.",
    id: "https://app.argu.co/i18n/errors/request/429/body",
  },
  "429/header": {
    defaultMessage: "Too many requests",
    id: "https://app.argu.co/i18n/errors/request/429/header",
  },
  "499/body": {
    defaultMessage: "There was a (network) issue during this request, check the internet connection, please retry or try a different browser.",
    id: "https://app.argu.co/i18n/errors/request/499/body",
  },
  "499/header": {
    defaultMessage: "Problem with the browser",
    id: "https://app.argu.co/i18n/errors/request/499/header",
  },
  "500/body": {
    defaultMessage: "An error occurred on our side, please try again later.",
    id: "https://app.argu.co/i18n/errors/request/500/body",
  },
  "500/header": {
    defaultMessage: "Internal server error",
    id: "https://app.argu.co/i18n/errors/request/500/header",
  },
  "501/body": {
    defaultMessage: "This feature isn't implemented, please try again later.",
    id: "https://app.argu.co/i18n/errors/request/501/body",
  },
  "501/header": {
    defaultMessage: "Not implemented",
    id: "https://app.argu.co/i18n/errors/request/501/header",
  },
  "502/body": {
    defaultMessage: "There was a networking issue during this request, please retry or try again later",
    id: "https://app.argu.co/i18n/errors/request/502/body",
  },
  "502/header": {
    defaultMessage: "Bad gateway",
    id: "https://app.argu.co/i18n/errors/request/502/header",
  },
  "503/body": {
    defaultMessage: "There was a networking issue during this request, please retry or try again later",
    id: "https://app.argu.co/i18n/errors/request/503/body",
  },
  "503/header": {
    defaultMessage: "Service unavailable",
    id: "https://app.argu.co/i18n/errors/request/503/header",
  },
  "504/body": {
    defaultMessage: "There was a networking issue during this request, please retry or try again later",
    id: "https://app.argu.co/i18n/errors/request/504/body",
  },
  "504/header": {
    defaultMessage: "Gateway timeout",
    id: "https://app.argu.co/i18n/errors/request/504/header",
  },
});

export function messageBodyForStatus(requestStatus: any) {
  if (!requestStatus.requested || requestStatus < HttpStatus.MULTIPLE_CHOICES) {
    return null;
  }

  const msg = messages[`${requestStatus.status}/body`];

  if (!msg) {
    handle(new Error(`translation missing for ${requestStatus.status}/body`));
    return null;
  }

  return msg;
}

export function bodyForStatus(requestStatus: any) {
  const msg = messageBodyForStatus(requestStatus);
  if (!msg) {
    return null;
  }

  return <FormattedMessage {...msg}/>;
}

export function headerForStatus(requestStatus: any) {
  if (!requestStatus.requested || requestStatus < HttpStatus.MULTIPLE_CHOICES) {
    return null;
  }

  const msg = messages[`${requestStatus.status}/header`];
  if (!msg) {
    handle(new Error(`translation missing for ${requestStatus.status}/header`));
    return null;
  }

  return <FormattedMessage {...msg} />;
}

export function titleForStatus(requestStatus: any) {
  if (!requestStatus || !requestStatus.requested) {
    return null;
  }

  return (
    <React.Fragment>
      {headerForStatus(requestStatus)} - ${bodyForStatus(requestStatus)}
    </React.Fragment>
  );
}
