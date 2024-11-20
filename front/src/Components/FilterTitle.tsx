import * as React from "react";

interface FTProps {
  children: React.ReactNode;
  helper?: string;
}

const FilterTitle: React.FunctionComponent<FTProps> = ({
  children,
  helper,
}) => {
  return (
    <span title={helper} className="Filter__Title">
      {children}
    </span>
  );
};

export default FilterTitle;
