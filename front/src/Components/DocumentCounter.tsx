import { useFetch } from "../helpers";
import { API } from "../config";

export const defaultDocsCount = 3033692;

interface ResultType {
  error?: Error | null;
  response?: {
    count: number;
  };
}

const useDocumentCounter = () => {
  const result: ResultType = useFetch(`${API}/*/_count?q=@type:MediaObject`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  let totalCount: number = defaultDocsCount;

  if (result.response != null) {
    console.log("result", result.response);
    totalCount = result.response.count;
  }

  const formatter = Intl.NumberFormat("nl", {});
  return formatter.format(totalCount);
};

export default useDocumentCounter;
