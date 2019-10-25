import React from "react";
import throttle from "lodash.throttle";
import { Resizable } from "re-resizable";
import Button from "./Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faGripHorizontal,
} from "@fortawesome/free-solid-svg-icons";
import { withRouter, RouteComponentProps } from "react-router";
import { usePersistedState } from "../helpers";
import { HotKeys } from "react-hotkeys";
import { keyMap } from "../helpers/keyMap";

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

const Handler = () =>
  <div className="SideDrawer__handler">
    <FontAwesomeIcon icon={faGripHorizontal} />
  </div>;

const SideDrawer = (props: SideDrawerProps & RouteComponentProps) => {
  const [width, setWidth] =
    usePersistedState<number>("orisearch.pdfviewer.width", determineInitialWith(window.innerWidth));

  const [glossIsOpen, toggleGlossarium] = 
    usePersistedState<boolean>("orisearch.pdfviewer.glossariumOpened", false);
    
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
    params.delete("showResource");
    props.history.push(`/search?${params.toString()}`);
  };

  const uglyStyleSetting = () => {
    // TODO: Dit is jammer maar het moet nou eenmaal. (component integratie)
    const ugly = document.getElementsByClassName("react-pdf__Page__textContent")[0] as HTMLElement;
    if (ugly !== undefined) {
      ugly.style.width = "100%";
    }
  }

  const toggleGloss = () => {
    toggleGlossarium(!glossIsOpen);
    if (!glossIsOpen) {
      setWidth(width + 400);
      uglyStyleSetting();
    } else {
      setWidth(width - 400);
    }
  }

  const keyHandlers = {
    CLOSE: closeDocument,
  };

  return (
    <SideDrawerContext.Provider
      value={{
        glossIsOpen,
        width,
        setWidth,
      }}
    >
      <HotKeys
        keyMap={keyMap}
        handlers={keyHandlers}
        className="SideDrawer__wrapper"
      >
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
          onResizeStop={(
            event: MouseEvent | TouchEvent,
            direction: any,
            refToElement: HTMLDivElement,
            delta: any,
          ) => {
            setWidth(width + delta.width);
            uglyStyleSetting();
          }}
          enable={{ left: true }}
        >
          <Button
            className="Button__openGlossary"
            onClick={toggleGloss}
          >
            {glossIsOpen ?
              "Close Glossarium" :
              "Open Glossarium"}
          </Button>
          <Button
            className="Button__close"
            onClick={closeDocument}
          >
            Sluiten
          </Button>
          <div
            className="SideDrawer__scroller"
            ref={pdfWrapper}
          >
            {typeof props.children === "function" ?
              props.children(width, setWidth) : props.children
            }
          </div>
        </Resizable>
      </HotKeys>
    </SideDrawerContext.Provider>
  );
};

export interface SideDrawerContextType {
  glossIsOpen: boolean;
  width: number;
  setWidth: Function;
}

export const SideDrawerContext = React.createContext<SideDrawerContextType>({
  width: 250,
  glossIsOpen: false,
  setWidth: () => null,
});

export default withRouter(SideDrawer);
