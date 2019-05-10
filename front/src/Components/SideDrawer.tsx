import React from "react";
import throttle from "lodash.throttle";
import Resizable from "re-resizable";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faGripHorizontal,
} from "@fortawesome/free-solid-svg-icons";
import { withRouter, RouteComponentProps } from "react-router";
import { usePersistedState } from "../helpers";

interface SideDrawerProps {
  children: React.ReactNode;
}

const MARGIN_LEFT = 200;

const calcMaxWidth = (windowWidth: number) => {
  if (windowWidth > 800) {
    return windowWidth - MARGIN_LEFT;
  }

  return windowWidth;
};

const determineInitialWith = (windowWidth: number) => {
  if (windowWidth < 800) {
    return windowWidth;
  }
  return windowWidth - 600;
};

const Handler = () =>
  <div className="SideDrawer__handler">
    <FontAwesomeIcon icon={faGripHorizontal} />
  </div>;

const SideDrawer = (props: SideDrawerProps & RouteComponentProps) => {
  const [width, setWidth] =
    usePersistedState<number>("orisearch.pdfviewer.width", determineInitialWith(window.innerWidth));
  const [maxWidth, setMaxWidth] = React.useState<number>(calcMaxWidth(window.innerWidth));

  const pdfWrapper = React.createRef<HTMLInputElement>();

  React.useLayoutEffect(() => {
    const handleResize = () => {
      if (pdfWrapper.current) {
        setWidth(pdfWrapper.current.getBoundingClientRect().width);
        setMaxWidth(calcMaxWidth(window.innerWidth));
      }
    };

    const listener = throttle(handleResize, 500);
    window.addEventListener("resize", listener);

    return () => window.removeEventListener("resize", listener);
  });

  const closeDocument = () => {
    const currentURL = new URL(window.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showDocument");
    props.history.push(`/search?${params.toString()}`);
  };

  return (
    <div className="ResourceBar">
      <Resizable
        size={{ width, height: "100%" }}
        className="SideDrawer"
        handleClasses={{
          left: "SideDrawer__resize-handle",
        }}
        handleComponent={{
          left: () => <Handler />,
        }}
        maxWidth={maxWidth}
        minWidth={200}
        onResizeStop={(_e, _direction, _ref, d) => setWidth(width + d.width)}
        enable={{ left: true }}
      >
        <Button
          className="Button__close"
          onClick={closeDocument}
        >
          Sluiten
        </Button>
        {typeof props.children === "function" ? props.children(width, setWidth) : props.children}
      </Resizable>
    </div>
  );
};

export default withRouter(SideDrawer);
