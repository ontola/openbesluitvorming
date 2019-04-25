export interface ORIItemType {
  _id: string;
  _score: number;
  _index: string;
  _type: string;
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
}
