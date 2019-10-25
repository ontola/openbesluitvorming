import { unstable, LinkReduxLRSType } from "link-redux";
// import { NamedNode } from "@ontologies/core";
import React from "react";
// import {
// INTERNAL_SERVER_ERROR,
//   PROXY_AUTHENTICATION_REQUIRED,
//   TOO_MANY_REQUESTS,
// } from "http-status-codes";
import { FormattedMessage } from "react-intl";

import Button from "./Button";
import { handle } from "../helpers/logging";

interface ErrorButtonProps {
  children?: React.ReactNode;
  linkRequestStatus?: {
    status: number;
  };
  location?: {
    pathname: string;
  };
  lrs?: LinkReduxLRSType;
  reloadLinkedObject?: Function;
  reset: Function;
}

// const RETRYABLE_ERRORS = [
//   PROXY_AUTHENTICATION_REQUIRED,
//   TOO_MANY_REQUESTS,
// ];

class ErrorButtonWithFeedback extends React.Component<ErrorButtonProps> {
  static contextType = unstable.LRSCtx;

  constructor(props: ErrorButtonProps) {
    super(props);

    this.state = {
      loading: false,
    };

    this.reload = this.reload.bind(this);
  }

  reload() {
    this.setState({ loading: true });
    const disable = () => {
      this.props.reset();
      this.setState({ loading: false });
    };

    if (!this.props.reloadLinkedObject) {
      this.setState({ loading: false });
      return this.props.reset();
    }

    this
      .props
      .reloadLinkedObject()
      .then(disable)
      .catch((e: Error) => {
        handle(e);
        return disable();
      });

    // return this
    //   .context
    //   .lrs
    //   .api
    //   .statusMap
    //   .forEach((s: any, i: any) => {
    //     if (s && (s.status >= INTERNAL_SERVER_ERROR || RETRYABLE_ERRORS.includes(s.status))) {
    //       this.context.lrs.queueEntity(NamedNode.findByStoreIndex(i), { reload: true });
    //     }
    //   });
  }

  render() {
    // const { linkRequestStatus } = this.props;

    return (
      <Button
        // icon="refresh"
        // loading={this.state.loading}
        // title={titleForStatus(linkRequestStatus)}
        onClick={this.reload}
        {...this.props}
      >
        {this.props.children ||
          <FormattedMessage id="https://app.argu.co/i18n/errors/inlineButton/label" />}
      </Button>
    );
  }
}

export default ErrorButtonWithFeedback;
