import React from "react";
import throttle from "lodash.throttle";
import { Resizable } from "re-resizable";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGripHorizontal } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { usePersistedState } from "../helpers";

interface SideDrawerProps {
  children: React.ReactNode;
}

const MARGIN_LEFT = 50;
const MAX_INIT_SIZE = 880;

const calcMaxWidth = (windowWidth: number) => {
  // Large screens
  if (windowWidth > 800) {
    return windowWidth - MARGIN_LEFT;
  }

  return windowWidth;
};

const determineInitialWith = (windowWidth: number) => {
  if (windowWidth > 1400) {
    return MAX_INIT_SIZE;
  }

  if (windowWidth > 800) {
    return windowWidth - 600;
  }

  return windowWidth;
};

const Handler = () => (
  <div className="SideDrawer__handler">
    <FontAwesomeIcon icon={faGripHorizontal} />
  </div>
);

const SideDrawer = (props: SideDrawerProps) => {
  const navigate = useNavigate();
  const [width, setWidth] = usePersistedState<number>(
    "orisearch.pdfviewer.width",
    determineInitialWith(globalThis.innerWidth),
  );

  const [maxWidth, setMaxWidth] = React.useState<number>(
    calcMaxWidth(globalThis.innerWidth),
  );

  const pdfWrapper = React.createRef<HTMLInputElement>();

  const closeDocument = () => {
    const currentURL = new URL(globalThis.location.href);
    const params = new URLSearchParams(currentURL.search);
    params.delete("showResource");
    navigate(`/?${params.toString()}`);
  };

  React.useLayoutEffect(() => {
    const handleResize = () => {
      if (pdfWrapper.current) {
        setWidth(pdfWrapper.current.getBoundingClientRect().width);
        setMaxWidth(calcMaxWidth(globalThis.innerWidth));
      }
    };

    const listener = throttle(handleResize, 500);
    globalThis.addEventListener("resize", listener);

    return () => globalThis.removeEventListener("resize", listener);
  });

  return (
    <SideDrawerContext.Provider
      value={{
        width,
        setWidth,
      }}
    >
      <div className="SideDrawer__wrapper">
        <Resizable
          size={{ width, height: "100%" }}
          className="SideDrawer"
          handleClasses={{
            left: "SideDrawer__resize-handle",
          }}
          handleComponent={{
            left: <Handler />,
          }}
          maxWidth={maxWidth}
          minWidth={200}
          onResizeStop={(_event: MouseEvent | TouchEvent, delta: any) => {
            setWidth(width + delta.width);
          }}
          enable={{ left: true }}
        >
          <Button className="Button__close" onClick={closeDocument}>
            Sluiten
          </Button>
          <div className="SideDrawer__scroller" ref={pdfWrapper}>
            {typeof props.children === "function"
              ? (
                props.children as (
                  width: number,
                  setWidth: (width: number) => void,
                ) => React.ReactNode
              )(width, setWidth)
              : props.children}
          </div>
        </Resizable>
      </div>
    </SideDrawerContext.Provider>
  );
};

export interface SideDrawerContextType {
  width: number;
  setWidth: (width: number) => void;
}

export const SideDrawerContext = React.createContext<SideDrawerContextType>({
  width: 250,
  setWidth: () => {},
});

export default SideDrawer;
