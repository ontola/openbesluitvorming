import * as React from "react";

interface DetailTypeProps {
  textArray: string[] | undefined;
}

const DetailHighlight: React.FunctionComponent<DetailTypeProps> = (props) => {
  return (
    <React.Fragment>
      {props.textArray && props.textArray.map(
        ((text: string) => (
          <div key={text} className="ResultCard__highlight">
            <span dangerouslySetInnerHTML={{ __html: `${text}...` }}/>
          </div>
        )))
      }
    </React.Fragment>
  );
};
export default DetailHighlight;
