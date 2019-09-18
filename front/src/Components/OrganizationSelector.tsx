
import * as React from "react";
import { getApiURL, useFetch } from '../helpers';
import Select from "react-select";
import { withRouter, RouteComponentProps } from 'react-router-dom'

const query = {
  "size": 500,
  "query": {
    "bool": {
      "must": {
        "match_all": {}
      },
      "filter": {
        "terms": {
          "classification": ["municipality", "province"]
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

  if (!result.response) {
    return <div>Loading...</div>
  }

  // Change the route to the filter of the organization

  const onSelectOrg = (event: any) => {
    console.log(event, props.history);

    const municipalityIndex = event.value;

    const currentURL = new URL(window.location.href);

    const pathWithQueryParams = `search?zoekterm="*"&organisaties=%5B"${municipalityIndex}"%5D`;
    const url = new URL(currentURL + pathWithQueryParams)
    console.log(url)
    props.history.push(pathWithQueryParams)
  }

  if (result.response !== undefined) {
    const hits = result.response.hits.hits;
    const totalCount = result.response.hits.total.value;

    const options: any = [];
    hits.map((h: Municipality) => {
      options.push({
        label: h._source.name,
        value: h._index,
      })
    })
    return (
      <div className="OrganizationSelector">
        <Select
          options={options}
          onChange={onSelectOrg}
          placeholder={`Kies uit ${totalCount} gemeenten en provincies...`}
        />
      </div>
    );
  }
  return null;
};

export default withRouter(OrganizationSelector);
