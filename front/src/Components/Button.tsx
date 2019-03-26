import * as React from "react";

interface ButtonProps {
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  title?: string;
}

const Button: React.FunctionComponent<ButtonProps> = (props) => {
  let className: string = "Button";
  if (props.className !== undefined) {
    className += ` ${props.className}`;
  }
  return (
    <button
      className={className}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
    >
      {props.children}
    </button>
  );
};

export default Button;