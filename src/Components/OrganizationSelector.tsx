import { useFetch } from "../helpers.ts";
import Creatable from "react-select/creatable";
import paths from "../paths.ts";
import { handle } from "../helpers/logging.ts";
import { API } from "../config.ts";
import { useNavigate } from "react-router";
import React from "react";

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

// https://github.com/openstate/open-raadsinformatie/issues/489
function UpdateBrokenNames(name: string) {
  if (name === "Aa en Maas") {
    return "Waterschap Aa en Maas";
  }
  if (name === "De Dommel") {
    return "Waterschap De Dommel";
  }
  if (name === "Zuiderzeeland") {
    return "Waterschap Zuiderzeeland";
  }
  if (name === "Hollandse Delta") {
    return "Waterschap Hollandse Delta";
  }
  if (name === "Hollands Scheldestromen") {
    return "Waterschap Hollands Scheldestromen";
  }

  return name;
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
    globalThis.location.href = paths.vngNewForm;
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
      const pathWithQueryParams =
        `?zoekterm="*"&organisaties=%5B"${municipalityIndex}"%5D`;
      navigate(pathWithQueryParams);
    };

    const hits = result.response.hits.hits;
    totalCount = result.response.hits.total.value.toString();

    hits.forEach(function (h: Municipality) {
      options.push({
        label: UpdateBrokenNames(h._source.name),
        value: h._index,
      });
    });
  }

  const placeholderEnd = `gemeenten, provincies en waterschappen...`;

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
