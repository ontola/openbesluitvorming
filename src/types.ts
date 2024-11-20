export interface ORIItemType {
  _id: string;
  _score: number;
  _index: string;
  // Ori ID, without the base
  "@id": string;
  "@type": string;
  // TODO: specify?
  _source: any;
  _version?: number;
  _explanation?: any;
  fields?: any;
  highlight?: any;
  hightlight: string;
  name?: string;
  had_primary_source: string;
  original_url?: string;
  inner_hits?: any;
  matched_queries?: string[];
  sort?: string[];
  ori_identifier: string;
  tags?: TopTags;
}

export interface Tag {
  "https://argu.co/ns/meeting/tag": string;
  "@type": "https://argu.co/ns/meeting/TagHit";
  "https://argu.co/ns/meeting/score": number;
  "@id": string;
}

export interface TopTags {
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#_8": Tag;
}

export const topTag = "http://www.w3.org/1999/02/22-rdf-syntax-ns#_8";
