export const handle = (e: Error) => {
  console.log(e);
};

export const printAndHandle = (e: Error | Response | unknown) => {
  if (e instanceof Error) {
    handle(e);
    return e.message;
  }
  if (Object.prototype.hasOwnProperty.call(e, "statusText")) {
    const error = new Error((e as Response).statusText);
    handle(error);
    return (e as Response).statusText;
  }
  return "Unkown error";
};
