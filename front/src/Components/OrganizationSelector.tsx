
import * as React from "react";
import { getApiURL, useFetch } from '../helpers';
import Creatable from "react-select/creatable";
import { withRouter, RouteComponentProps } from 'react-router-dom'
import paths from "../paths";
import { handle } from "../helpers/logging";
import { IS_ORI } from "../config";

const query = {
  "size": 500,
  "query": {
    "bool": {
      "must": {
        "match_all": {}
      },
      "filter": {
        "terms": {
          "classification": IS_ORI ? ["municipality"] : ["municipality", "province"]
        }
      }
    }
  }
}

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
  "_index": string;
  "_id": number;
  "_source": {
    name: string;
  };
}

const OrganizationSelector = (props: RouteComponentProps) => {
  const result: ResultType = useFetch(`${getApiURL().toString()}/_search?`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query)
  });

  const handleCreateOption = () => {
    window.location.href = paths.vngNewForm;
  }

  let totalCount = "126";
  const options: any = [];
  let onSelectOrg = (event: any) => {handle(event)}
  let isLoading = true;

  if (result.response != null) {
    isLoading = false;
    onSelectOrg = (event: any) => {
      const municipalityIndex = event.value;
      const pathWithQueryParams = `?zoekterm="*"&organisaties=%5B"${municipalityIndex}"%5D`;
      props.history.push(pathWithQueryParams)
    }

    const hits = result.response.hits.hits;
    totalCount = result.response.hits.total.value.toString();

    hits.map(function(h: Municipality) {
      options.push({
        label: h._source.name,
        value: h._index,
      })
    })
  }

  const placeholderEnd = IS_ORI ? `gemeenten...` : `gemeenten en provincies...`

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
  )
  ;
};

export default withRouter(OrganizationSelector);
