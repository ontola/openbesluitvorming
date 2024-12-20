import * as React from "react";
import { useFetch } from "../helpers";
import Creatable from "react-select/creatable";
import paths from "../paths";
import { handle } from "../helpers/logging";
import { API } from "../config";
import { useNavigate } from "react-router";

/** The amount of participating municipalities / provinces */
export const defaultOrgsCount = "317";

const query = {
  size: 500,
  query: {
    bool: {
      must: {
        match_all: {},
      },
      filter: {
        bool: {
          should: [
            { match: { classification: "municipality" } },
            { match: { classification: "province" } },
            { match: { classification: "water" } },
          ],
          minimum_should_match: 1,
        },
      },
    },
  },
};

interface ResultType {
  error?: Error | null;
  response?: null | {
    hits: {
      total: {
        value: number;
      };
      hits: Municipality[];
    };
  };
}

interface Municipality {
  _index: string;
  _id: number;
  _source: {
    name: string;
  };
}

const OrganizationSelector = () => {
  const result: ResultType = useFetch(`${API}/_search?`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(query),
  });

  const handleCreateOption = () => {
    window.location.href = paths.vngNewForm;
  };

  let totalCount = defaultOrgsCount;
  const options: any = [];
  let onSelectOrg = (event: any) => {
    handle(event);
  };
  let isLoading = true;

  const navigate = useNavigate();

  if (result.response != null) {
    isLoading = false;
    onSelectOrg = (event: any) => {
      const municipalityIndex = event.value;
      const pathWithQueryParams = `?zoekterm="*"&organisaties=%5B"${municipalityIndex}"%5D`;
      navigate(pathWithQueryParams);
    };

    const hits = result.response.hits.hits;
    totalCount = result.response.hits.total.value.toString();

    hits.forEach(function (h: Municipality) {
      options.push({
        label: h._source.name,
        value: h._index,
      });
    });
  }

  // const placeholderEnd = IS_ORI ? `gemeenten...` : `gemeenten en provincies...`
  const placeholderEnd = `gemeenten en provincies...`;

  return (
    <div className="OrganizationSelector">
      <Creatable
        formatCreateLabel={(value: string) => `+ ${value} toevoegen`}
        isLoading={isLoading}
        options={options}
        onChange={onSelectOrg}
        placeholder={`Kies uit ${totalCount} ${placeholderEnd}`}
        onCreateOption={handleCreateOption}
      />
    </div>
  );
};

export default OrganizationSelector;
